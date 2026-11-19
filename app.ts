// createApp(): a single-process, GitHub-compatible forge over HTTP.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ForgeStore, globalId, type Repo, type Issue, type Pull } from './store.ts';
import { handleGitRequest } from './gitprotocol.ts';
import { runGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function tokenFromRequest(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1].trim();
  const basic = /^Basic\s+(.+)$/i.exec(header);
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      return password || decoded;
    } catch {
      return null;
    }
  }
  return null;
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = tokenFromRequest(req);
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  return expected ? token === expected : true;
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): void {
  const body = status === 204 ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { message: error.message });
  } else {
    sendJson(res, 500, { message: (error as Error)?.message || 'Internal error' });
  }
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'JSON body must be an object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Malformed JSON body');
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value);
}

function iso(seq: number): string {
  return new Date(1700000000000 + seq * 1000).toISOString();
}

function repoJson(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const host = req.headers.host || 'localhost';
  return {
    id: repo.id,
    node_id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: globalId('User', repo.owner, 0),
      type: 'User',
      avatar_url: '',
    },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.seq),
    updated_at: iso(repo.seq),
    pushed_at: iso(repo.seq),
    size: 0,
    fork: false,
    archived: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `http://${host}/${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(store: ForgeStore, repo: Repo, name: string): Record<string, unknown> {
  const label = store.label(repo, name);
  return { id: label?.id || '', name, color: label?.color || 'ffffff', default: false };
}

function issueJson(store: ForgeStore, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toLowerCase(),
    labels: issue.labels.map((name) => labelJson(store, repo, name)),
    user: { login: repo.owner, type: 'User' },
    assignee: null,
    comments: issue.comments.length,
    created_at: iso(issue.seq),
    updated_at: iso(issue.seq + issue.comments.length),
    closed_at: issue.state === 'CLOSED' ? iso(issue.seq + 1) : null,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: ForgeStore, repo: Repo, pull: Pull): Record<string, unknown> {
  const headOid = store.resolve(repo, pull.head) || '';
  const baseOid = store.resolve(repo, pull.base) || '';
  const summary = repoJson({ headers: {} } as IncomingMessage, repo);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'MERGED' ? 'closed' : pull.state.toLowerCase(),
    draft: false,
    merged: pull.merged,
    mergeable: pull.merged ? false : store.mergeable(repo, pull),
    rebaseable: false,
    mergeable_state: pull.merged ? 'merged' : store.mergeable(repo, pull) ? 'clean' : 'dirty',
    merged_at: pull.merged ? iso(pull.seq + 1) : null,
    created_at: iso(pull.seq),
    updated_at: iso(pull.seq),
    closed_at: pull.state === 'CLOSED' ? iso(pull.seq + 1) : null,
    merge_commit_sha: pull.mergeCommitOid,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headOid, repo: summary },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseOid, repo: summary },
    user: { login: repo.owner, type: 'User' },
    changed_files: pull.files.length,
    additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    commits: 1,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function needRepo(store: ForgeStore, owner: string, name: string): Repo {
  const repo = store.getRepo(owner, name);
  if (!repo) throw new HttpError(404, 'Not Found');
  return repo;
}

async function handleUserRepos(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method === 'POST') {
    const body = await readJson(req);
    const name = str(body.name).trim();
    if (!name) throw new HttpError(422, 'name is required');
    let repo: Repo;
    try {
      repo = store.createRepo(store.login, name, str(body.description), Boolean(body.private));
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    sendJson(res, 201, repoJson(req, repo));
    return;
  }
  if (req.method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') || 30) || 30));
    const repos = store.listRepos(store.login);
    const slice = repos.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    const links: string[] = [];
    const origin = `http://${req.headers.host || 'localhost'}`;
    const base = `${origin}/api/v3/user/repos`;
    if (page * perPage < repos.length) {
      links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    }
    if (page > 1) links.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
    links.push(`<${base}?page=${Math.max(1, Math.ceil(repos.length / perPage))}&per_page=${perPage}>; rel="last"`);
    if (links.length) headers.Link = links.join(', ');
    sendJson(res, 200, slice.map((repo) => repoJson(req, repo)), headers);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

async function handleContents(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
  url: URL,
): Promise<void> {
  const path = parts.join('/').replace(/^\/+|\/+$/g, '');
  const branch = str(url.searchParams.get('branch') || repo.defaultBranch);
  const files = store.fileMap(repo, branch);
  const current = files.get(path);

  if (req.method === 'GET') {
    if (current) {
      const bytes = store.getObject(repo, current.oid)?.data || Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: current.oid,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
        download_url: `/raw/${repo.owner}/${repo.name}/${branch}/${path}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
      return;
    }
    const prefix = path ? `${path}/` : '';
    const children = new Map<string, { type: string; oid: string; size: number }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (slash >= 0) {
        if (!children.has(name)) children.set(name, { type: 'dir', oid: '', size: 0 });
      } else {
        children.set(name, {
          type: 'file',
          oid: entry.oid,
          size: store.getObject(repo, entry.oid)?.data.length || 0,
        });
      }
    }
    if (!children.size) throw new HttpError(404, 'Not Found');
    sendJson(
      res,
      200,
      [...children.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, value]) => ({
        type: value.type,
        name,
        path: path ? `${path}/${name}` : name,
        sha: value.oid,
        size: value.size,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path ? `${path}/${name}` : name}`,
      })),
    );
    return;
  }

  if (req.method === 'PUT') {
    const body = await readJson(req);
    if (current && str(body.sha) && str(body.sha) !== current.oid) {
      throw new HttpError(409, 'sha does not match current file');
    }
    const bytes = Buffer.from(str(body.content), 'base64');
    const blob = store.addObject(repo, 'blob', bytes);
    const message = str(body.message, `Update ${path}`);
    const sha = store.commitChanges(
      repo,
      str(body.branch, branch),
      [{ path, oid: blob }],
      message,
    );
    sendJson(res, current ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blob,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        download_url: `/raw/${repo.owner}/${repo.name}/${branch}/${path}`,
      },
      commit: { sha, message, tree: store.resolve(repo, sha) },
    });
    return;
  }

  if (req.method === 'DELETE') {
    const body = await readJson(req);
    if (!current) throw new HttpError(404, 'Not Found');
    if (str(body.sha) && str(body.sha) !== current.oid) {
      throw new HttpError(409, 'sha does not match current file');
    }
    const message = str(body.message, `Delete ${path}`);
    const sha = store.commitChanges(repo, str(body.branch, branch), [{ path, oid: null }], message);
    sendJson(res, 200, { content: null, commit: { sha, message } });
    return;
  }
  throw new HttpError(404, 'Not Found');
}

async function handleIssues(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
  url: URL,
): Promise<void> {
  if (!parts.length) {
    if (req.method === 'POST') {
      const body = await readJson(req);
      const title = str(body.title).trim();
      if (!title) throw new HttpError(422, 'title is required');
      const labels = Array.isArray(body.labels)
        ? body.labels.map((label) => (typeof label === 'string' ? label : str((label as Record<string, unknown>).name)))
        : [];
      let issue: Issue;
      try {
        issue = store.createIssue(repo, title, str(body.body), labels);
      } catch (error) {
        throw new HttpError(422, (error as Error).message);
      }
      sendJson(res, 201, issueJson(store, repo, issue));
      return;
    }
    if (req.method === 'GET') {
      const state = str(url.searchParams.get('state') || 'open').toLowerCase();
      const direction = str(url.searchParams.get('direction') || 'desc').toLowerCase();
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state.toLowerCase() === state)
        .sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq))
        .map((issue) => issueJson(store, repo, issue));
      sendJson(res, 200, issues);
      return;
    }
  }
  const number = Number(parts[0]);
  const issue = repo.issues.get(number);
  if (!issue) throw new HttpError(404, 'Not Found');
  if (parts.length === 1) {
    if (req.method === 'GET') {
      sendJson(res, 200, issueJson(store, repo, issue));
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (body.title !== undefined) issue.title = str(body.title);
      if (body.body !== undefined) issue.body = str(body.body);
      if (body.state !== undefined) {
        const state = str(body.state).toLowerCase();
        if (state !== 'open' && state !== 'closed') throw new HttpError(422, 'invalid state');
        issue.state = state === 'open' ? 'OPEN' : 'CLOSED';
      }
      if (body.labels !== undefined) {
        const labels = Array.isArray(body.labels)
          ? body.labels.map((label) => (typeof label === 'string' ? label : str((label as Record<string, unknown>).name)))
          : [];
        for (const label of labels) if (!store.label(repo, label)) throw new HttpError(422, `Unknown label: ${label}`);
        issue.labels = labels;
      }
      sendJson(res, 200, issueJson(store, repo, issue));
      return;
    }
  }
  if (parts.length === 2 && parts[1] === 'comments') {
    if (req.method === 'GET') {
      sendJson(
        res,
        200,
        issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: repo.owner },
          created_at: iso(comment.seq),
        })),
      );
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const comment = store.addComment(repo, issue, str(body.body));
      sendJson(res, 201, {
        id: comment.id,
        body: comment.body,
        user: { login: repo.owner },
        created_at: iso(comment.seq),
      });
      return;
    }
  }
  throw new HttpError(404, 'Not Found');
}

async function handlePulls(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
  url: URL,
): Promise<void> {
  if (!parts.length) {
    if (req.method === 'POST') {
      const body = await readJson(req);
      const head = str(body.head).split(':').pop() || '';
      const base = str(body.base, repo.defaultBranch).split(':').pop() || repo.defaultBranch;
      if (!head || !base) throw new HttpError(422, 'head and base are required');
      if (!store.resolve(repo, head) || !store.resolve(repo, base)) {
        throw new HttpError(422, 'head or base branch not found');
      }
      const pull = store.createPull(repo, str(body.title, head), head, base, str(body.body));
      sendJson(res, 201, pullJson(store, repo, pull));
      return;
    }
    if (req.method === 'GET') {
      const state = str(url.searchParams.get('state') || 'open').toLowerCase();
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state.toLowerCase() === state)
        .sort((a, b) => b.number - a.number)
        .map((pull) => pullJson(store, repo, pull));
      sendJson(res, 200, pulls);
      return;
    }
  }
  const number = Number(parts[0]);
  const pull = repo.pulls.get(number);
  if (!pull) throw new HttpError(404, 'Not Found');
  if (parts.length === 1 && req.method === 'GET') {
    sendJson(res, 200, pullJson(store, repo, pull));
    return;
  }
  if (parts.length === 2 && parts[1] === 'files' && req.method === 'GET') {
    sendJson(
      res,
      200,
      pull.files.map((file) => ({
        sha: file.path,
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
        patch: '',
      })),
    );
    return;
  }
  if (parts.length === 2 && parts[1] === 'merge' && req.method === 'PUT') {
    const body = await readJson(req);
    if (pull.merged) throw new HttpError(405, 'Pull request is already merged');
    const result = store.mergePull(repo, pull, str(body.merge_method, 'squash'));
    if (!result) throw new HttpError(405, 'Pull request has conflicts');
    sendJson(res, 200, {
      sha: result.oid,
      merged: true,
      message: result.message,
    });
    return;
  }
  throw new HttpError(404, 'Not Found');
}

async function handleGitRefs(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  parts: string[],
): Promise<void> {
  const refPath = parts.join('/');
  const fullRef = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
  if (req.method === 'GET') {
    if (!refPath) {
      sendJson(
        res,
        200,
        [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } })),
      );
      return;
    }
    const sha = store.resolve(repo, fullRef);
    if (!sha) throw new HttpError(404, 'Not Found');
    sendJson(res, 200, { ref: fullRef, object: { sha, type: 'commit' } });
    return;
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !sha) throw new HttpError(422, 'ref and sha are required');
    if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    store.touch(repo);
    sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
    return;
  }
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const sha = str(body.sha);
    if (!repo.refs.has(fullRef)) throw new HttpError(404, 'Not Found');
    if (!sha) throw new HttpError(422, 'sha is required');
    store.setRef(repo, fullRef, sha);
    sendJson(res, 200, { ref: fullRef, object: { sha, type: 'commit' } });
    return;
  }
  if (req.method === 'DELETE') {
    if (!repo.refs.has(fullRef)) throw new HttpError(404, 'Not Found');
    store.deleteRef(repo, fullRef);
    sendJson(res, 204, null);
    return;
  }
  throw new HttpError(404, 'Not Found');
}

function branchesJson(repo: Repo): Record<string, unknown>[] {
  const prefix = 'refs/heads/';
  return [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith(prefix))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ref, sha]) => ({
      name: ref.slice(prefix.length),
      commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    }));
}

function commitsJson(store: ForgeStore, repo: Repo, ref: string | null): Record<string, unknown>[] {
  const oid = store.resolve(repo, ref || `refs/heads/${repo.defaultBranch}`);
  if (!oid) return [];
  const result: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = store.commitInfo(repo, sha);
    result.push({
      sha,
      commit: {
        message: info?.message.trim() || '',
        author: { name: 'Forge', email: 'forge@local' },
      },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    });
    if (info) queue.push(...info.parents);
  }
  return result;
}

async function handleRest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
): Promise<void> {
  const sub = parts.slice(2);
  if (!sub.length) {
    if (req.method !== 'GET') throw new HttpError(404, 'Not Found');
    res.setHeader('X-OAuth-Scopes', 'repo, workflow, read:org, write:packages');
    res.setHeader('X-Accepted-OAuth-Scopes', 'repo');
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      authenticate_url: '/api/v3/authorizations',
      rate_limit_url: '/api/v3/rate_limit',
      message: 'GitHub-compatible forge',
    });
    return;
  }
  if (sub[0] === 'meta' && sub.length === 1 && req.method === 'GET') {
    sendJson(res, 200, {
      installed_version: '1.0.0',
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_url: 'ssh://forge',
    });
    return;
  }
  if (sub[0] === 'user' && sub[1] === 'repos' && sub.length === 2) {
    await handleUserRepos(store, req, res, url);
    return;
  }
  if (sub[0] === 'user' && sub.length === 1 && req.method === 'GET') {
    sendJson(res, 200, { login: store.login, id: globalId('User', store.login, 0), type: 'User' });
    return;
  }
  if (sub[0] !== 'repos' || sub.length < 3) throw new HttpError(404, 'Not Found');
  const repo = needRepo(store, sub[1], sub[2]);
  const rest = sub.slice(3);
  if (!rest.length) {
    if (req.method === 'GET') {
      sendJson(res, 200, repoJson(req, repo));
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (body.description !== undefined) repo.description = str(body.description);
      if (body.private !== undefined) repo.isPrivate = Boolean(body.private);
      if (body.default_branch !== undefined) repo.defaultBranch = str(body.default_branch, repo.defaultBranch);
      if (body.name !== undefined && str(body.name) !== repo.name) {
        const newName = str(body.name);
        if (store.getRepo(repo.owner, newName)) throw new HttpError(422, 'Repository already exists');
        store.renameRepo(repo, newName);
      }
      sendJson(res, 200, repoJson(req, repo));
      return;
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(repo);
      sendJson(res, 204, null);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  switch (rest[0]) {
    case 'branches':
      if (req.method === 'GET' && rest.length === 1) {
        sendJson(res, 200, branchesJson(repo));
        return;
      }
      throw new HttpError(404, 'Not Found');
    case 'commits':
      if (req.method === 'GET' && rest.length === 1) {
        sendJson(res, 200, commitsJson(store, repo, url.searchParams.get('sha')));
        return;
      }
      throw new HttpError(404, 'Not Found');
    case 'contents':
      await handleContents(store, req, res, repo, rest.slice(1), url);
      return;
    case 'labels':
      if (req.method === 'POST' && rest.length === 1) {
        const body = await readJson(req);
        const name = str(body.name).trim();
        if (!name) throw new HttpError(422, 'name is required');
        const label = store.addLabel(repo, name, str(body.color, 'ffffff'), str(body.description));
        sendJson(res, 201, { id: label.id, name: label.name, color: label.color, default: false });
        return;
      }
      if (req.method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({
          id: label.id, name: label.name, color: label.color, default: false,
        })));
        return;
      }
      throw new HttpError(404, 'Not Found');
    case 'issues':
      await handleIssues(store, req, res, repo, rest.slice(1), url);
      return;
    case 'pulls':
      await handlePulls(store, req, res, repo, rest.slice(1), url);
      return;
    case 'git': {
      if (rest[1] === 'refs' || rest[1] === 'ref') {
        await handleGitRefs(store, req, res, repo, rest.slice(2));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }
    default:
      throw new HttpError(404, 'Not Found');
  }
}

export function createApp(): http.Server {
  const store = new ForgeStore();
  let requestCounter = 0;

  const server = http.createServer(async (req, res) => {
    const requestId = `req-${++requestCounter}`;
    res.setHeader('X-GitHub-Request-Id', requestId);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map((part) => {
        try { return decodeURIComponent(part); } catch { return part; }
      });

      if (parts.length === 1 && parts[0] === 'healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!isAuthorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      if (parts[0] === 'mcp' && parts.length === 1 && req.method === 'POST') {
        const response = handleMcp(store, await readRaw(req));
        res.writeHead(response.status, response.headers);
        res.end(response.body);
        return;
      }
      if (parts[0] === 'api' && parts[1] === 'graphql' && parts.length === 2 && req.method === 'POST') {
        const raw = await readRaw(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'Malformed JSON body');
        }
        const execute = (entry: Record<string, unknown>): unknown =>
          runGraphql(store, str(entry.query), (entry.variables && typeof entry.variables === 'object'
            ? entry.variables
            : {}) as Record<string, unknown>, entry.operationName ? str(entry.operationName) : undefined);
        if (Array.isArray(body)) {
          sendJson(res, 200, body.map((entry) => execute(entry as Record<string, unknown>)));
        } else if (body && typeof body === 'object') {
          sendJson(res, 200, execute(body as Record<string, unknown>));
        } else {
          throw new HttpError(400, 'Invalid GraphQL request');
        }
        return;
      }
      if (parts[0] === 'api' && parts[1] === 'v3') {
        await handleRest(store, req, res, parts, url);
        return;
      }
      if (parts.length >= 2 && parts[1].endsWith('.git')) {
        await handleGitRequest(store, req, res, parts, url);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, error);
    }
  });

  return server;
}
