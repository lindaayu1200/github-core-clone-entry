// github-core-clone-01 forge: git smart HTTP + REST v3 + GraphQL v4 + MCP, all in-memory.
// Node 22, stdlib only. main.ts (unchanged) binds the port; this file exports createApp.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, createInflate } from 'node:zlib';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FORGE_VERSION = 'forge-1.0.0';
const ZERO_OID = '0'.repeat(40);

type Json = Record<string, unknown>;
type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: GitObjectType; data: Buffer }

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `${FORGE_VERSION}-${requestCounter.toString(16)}-${Date.now().toString(36)}`;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  authed: boolean;
  jsonBody: Json;
}

function sendRaw(ctx: Ctx, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  const h: Record<string, string> = { 'x-github-request-id': requestId(), ...headers };
  ctx.res.writeHead(status, h);
  ctx.res.end(body);
}

function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendRaw(ctx, status, Buffer.from(JSON.stringify(body), 'utf8'), {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function sendError(ctx: Ctx, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(ctx, status, { message, documentation_url: 'https://docs.github.com/rest' }, headers);
}

function readBody(ctx: Ctx, limit = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    ctx.req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); ctx.req.destroy(); return; }
      chunks.push(c);
    });
    ctx.req.on('end', () => resolve(Buffer.concat(chunks)));
    ctx.req.on('error', reject);
  });
}

// ============================== git object model ==============================

function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface TreeEntry { mode: string; name: string; oid: string }

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const bn = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(an, bn);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[] }

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return { tree, parents };
}

function parseTag(data: Buffer): { object: string; type: GitObjectType; tag: string } {
  const text = data.toString('utf8');
  const object = /^object ([0-9a-f]{40})/m.exec(text)?.[1] ?? ZERO_OID;
  const type = (/^type (\w+)/m.exec(text)?.[1] ?? 'commit') as GitObjectType;
  const tag = /^tag (.*)$/m.exec(text)?.[1] ?? '';
  return { object, type, tag };
}

/** All commits reachable from tips, not descending past commits in `stopAt`. */
function walkCommits(repo: Repo, tips: string[], stopAt: Set<string> = new Set()): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const t of tips) if (repo.objects.has(t)) queue.push(t);
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      if (stopAt.has(oid)) continue;
      for (const p of parseCommit(obj.data).parents) if (!seen.has(p)) queue.push(p);
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return walkCommits(repo, [descendant]).has(ancestor);
}

// ---- pack reading (push) ----

async function readPack(buf: Buffer, lookupExternal: (oid: string) => GitObject | undefined): Promise<Map<string, GitObject>> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack');
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const objects = new Map<string, GitObject>();
  interface Raw { offset: number; typeCode: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObject }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buf[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = buf[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    void size;
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      byte = buf[offset];
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset];
        offset += 1;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (![1, 2, 3, 4].includes(typeCode)) {
      throw new Error(`bad pack type ${typeCode}`);
    }
    const { data: inflated, consumed } = await inflateWithConsumed(buf.subarray(offset, trailerStart));
    entry.data = inflated;
    offset += consumed;
    raws.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved) return entry.resolved;
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('bad ofs-delta base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseOid = entry.baseOid!;
      let base = lookupExternal(baseOid);
      for (const r of raws) {
        if (!r.resolved) resolve(r);
        if (r.resolved && hashObject(r.resolved.type, r.resolved.data) === baseOid) { base = r.resolved; break; }
      }
      if (!base) throw new Error('missing ref-delta base');
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    entry.resolved = { type, data };
    return entry.resolved;
  };
  for (const entry of raws) {
    const obj = resolve(entry);
    const oid = hashObject(obj.type, obj.data);
    if (!objects.has(oid)) objects.set(oid, obj);
  }
  return objects;
}

/** Inflate from `start` and report exactly how many compressed bytes the stream consumed. */
function inflateWithConsumed(window: Buffer): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (c: Buffer) => chunks.push(c));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.end(window);
  });
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readSize();
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, offset, offset + n);
      offset += n;
      written += n;
    }
  }
  return out;
}

function writePack(objects: GitObject[]): Buffer {
  const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = TYPE_CODE[object.type];
    const size = object.data.length;
    const bytes: number[] = [];
    let first = (code << 4) | (size & 0x0f);
    let remaining = Math.floor(size / 16);
    while (remaining > 0) {
      bytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ============================== store ==============================

interface IssueRec {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; createdAt: number; updatedAt: number;
  comments: Array<{ id: number; body: string; createdAt: number }>;
}

interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number }

interface PullRec {
  id: number; number: number; title: string; body: string;
  head: string; base: string; headSha: string; baseSha: string; mergeBase: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  files: PullFile[]; createdAt: number;
}

interface Repo {
  name: string; owner: string | null; private: boolean; description: string;
  defaultBranch: string; createdAt: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, { id: number; name: string; color: string }>;
  nextNumber: number; nextIssueId: number; nextCommentId: number; labelSeq: number;
}

const repos = new Map<string, Repo>();
const repoIds = new WeakMap<Repo, number>();
let repoSeq = 1000;
let loginLearned: string | null = null;

function learnLogin(owner: string): void {
  if (owner && owner !== 'owner' && (loginLearned === null || loginLearned === 'owner')) loginLearned = owner;
}
function currentLogin(): string {
  return loginLearned ?? 'owner';
}

function repoIdOf(repo: Repo): number {
  let id = repoIds.get(repo);
  if (id === undefined) {
    id = repoSeq;
    repoSeq += 1;
    repoIds.set(repo, id);
  }
  return id;
}

function lookupRepo(owner: string, name: string): Repo | null {
  learnLogin(owner);
  const repo = repos.get(name);
  if (!repo) return null;
  if (repo.owner === null || repo.owner === 'owner') { repo.owner = owner; return repo; }
  if (repo.owner !== owner) return null;
  return repo;
}

function createRepo(name: string, priv: boolean, description: string): Repo {
  const existing = repos.get(name);
  if (existing) return existing;
  const repo: Repo = {
    name, owner: currentLogin(), private: priv, description,
    defaultBranch: 'main', createdAt: Date.now(),
    objects: new Map(), refs: new Map(), issues: new Map(), pulls: new Map(), labels: new Map(),
    nextNumber: 1, nextIssueId: 10000, nextCommentId: 1, labelSeq: 1,
  };
  repos.set(name, repo);
  return repo;
}

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return files;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(repo, entry.oid, `${prefix}${entry.name}/`)) files.set(k, v);
    } else if (entry.mode !== '160000') {
      files.set(`${prefix}${entry.name}`, entry.oid);
    }
  }
  return files;
}

function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node { files: Map<string, string>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      if (seg === '') continue;
      if (!node.dirs.has(seg)) node.dirs.set(seg, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(seg)!;
    }
    node.files.set(segments[segments.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function makeCommit(repo: Repo, files: Map<string, string>, message: string, parents: string[]): string {
  const tree = buildTreeFromFiles(repo, files);
  const stamp = `${Math.floor(Date.now() / 1000)} +0000`;
  const who = `Forge <forge@make.fun> ${stamp}`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return putObject(repo, 'commit', Buffer.from(`${lines.join('\n')}\n${message}\n`, 'utf8'));
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function commitFileChange(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): string {
  let tip = branchTip(repo, branch);
  if (tip === null) {
    const base = branchTip(repo, repo.defaultBranch);
    if (base !== null) { repo.refs.set(`refs/heads/${branch}`, base); tip = base; }
  }
  const files = tip === null ? new Map<string, string>() : flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  if (content === null) files.delete(path);
  else files.set(path, putObject(repo, 'blob', content));
  const commit = makeCommit(repo, files, message, tip === null ? [] : [tip]);
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}

function lineDiffCount(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(oldText);
  const b = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of b) { const have = a.get(line) ?? 0; if (n > have) additions += n - have; }
  for (const [line, n] of a) { const have = b.get(line) ?? 0; if (n > have) deletions += n - have; }
  return { additions, deletions };
}

function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
  const baseFiles = baseTree === null ? new Map<string, string>() : flattenTree(repo, baseTree);
  const headFiles = headTree === null ? new Map<string, string>() : flattenTree(repo, headTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const files: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before === after) continue;
    const oldText = before === undefined ? '' : repo.objects.get(before)!.data.toString('utf8');
    const newText = after === undefined ? '' : repo.objects.get(after)!.data.toString('utf8');
    const { additions, deletions } = lineDiffCount(oldText, newText);
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions, deletions, changes: additions + deletions,
    });
  }
  return files;
}

/** Closest common ancestor of two commits (BFS from one, first hit in the other's ancestor set). */
function findMergeBase(repo: Repo, a: string, b: string): string {
  if (a === b) return a;
  const ancestorsOfB = walkCommits(repo, [b]);
  const seen = new Set<string>();
  const queue: string[] = [a];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) if (!seen.has(p)) queue.push(p);
  }
  return a;
}

/** Conflict: a path the PR changes was already changed on base since mergeBase (and head didn't match). */
function mergeConflict(repo: Repo, pull: PullRec): boolean {
  const baseTip = branchTip(repo, pull.base);
  if (baseTip === null) return false;
  const baseTipFiles = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const mergeBaseFiles = flattenTree(repo, parseCommit(repo.objects.get(pull.mergeBase)!.data).tree);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(pull.headSha)!.data).tree);
  for (const file of pull.files) {
    const path = file.filename;
    if (baseTipFiles.get(path) === mergeBaseFiles.get(path)) continue;
    const headContent = headFiles.get(path);
    if (headContent !== baseTipFiles.get(path) && headContent !== mergeBaseFiles.get(path)) return true;
  }
  return false;
}

function squashMerge(repo: Repo, pull: PullRec): string {
  const baseTip = branchTip(repo, pull.base)!;
  const files = new Map(flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree));
  const mergeBaseFiles = flattenTree(repo, parseCommit(repo.objects.get(pull.mergeBase)!.data).tree);
  const headFiles = flattenTree(repo, parseCommit(repo.objects.get(pull.headSha)!.data).tree);
  for (const file of pull.files) {
    const path = file.filename;
    const headContent = headFiles.get(path);
    if (headContent === mergeBaseFiles.get(path)) continue;
    if (headContent === undefined) files.delete(path);
    else files.set(path, headContent);
  }
  const commit = makeCommit(repo, files, `${pull.title} (#${pull.number})`, [baseTip]);
  repo.refs.set(`refs/heads/${pull.base}`, commit);
  return commit;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- JSON views ----

function repoJson(repo: Repo): Json {
  const id = repoIdOf(repo);
  const owner = repo.owner ?? currentLogin();
  return {
    id, node_id: `R_${id}`, name: repo.name, full_name: `${owner}/${repo.name}`,
    private: repo.private,
    owner: { login: owner, id: 1, type: 'User', avatar_url: 'x', html_url: 'x' },
    description: repo.description, fork: false, default_branch: repo.defaultBranch,
    created_at: iso(repo.createdAt), updated_at: iso(repo.createdAt), pushed_at: iso(repo.createdAt),
    html_url: `/${owner}/${repo.name}`, clone_url: `/${owner}/${repo.name}.git`,
    has_issues: true, has_pull_requests: true, size: repo.objects.size,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(repo: Repo, issue: IssueRec): Json {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ id: 100 + name.length, name, color: repo.labels.get(name)?.color ?? 'ededed', default: false })),
    user: { login: currentLogin(), id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: iso(issue.createdAt), updated_at: iso(issue.updatedAt),
    closed_at: issue.state === 'closed' ? iso(issue.updatedAt) : null,
    html_url: 'x', url: 'x',
  };
}

function pullJson(repo: Repo, pull: PullRec): Json {
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body,
    state: pull.state, merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    head: { ref: pull.head, label: `${currentLogin()}:${pull.head}`, sha: pull.headSha, repo: repoJson(repo) },
    base: { ref: pull.base, label: `${currentLogin()}:${pull.base}`, sha: branchTip(repo, pull.base) ?? pull.baseSha, repo: repoJson(repo) },
    user: { login: currentLogin(), id: 1, type: 'User' },
    created_at: iso(pull.createdAt), updated_at: iso(pull.createdAt),
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? iso(pull.createdAt)) : null,
    html_url: 'x', url: 'x', commits: 1, changed_files: pull.files.length,
    additions: pull.files.reduce((n, f) => n + f.additions, 0),
    deletions: pull.files.reduce((n, f) => n + f.deletions, 0),
  };
}

// ============================== REST v3 ==============================

function paginate(ctx: Ctx, items: unknown[], perPageDefault = 30): { page: unknown[]; headers: Record<string, string> } {
  const perPageRaw = ctx.url.searchParams.get('per_page');
  const pageRaw = ctx.url.searchParams.get('page');
  const perPage = Math.max(1, Math.min(100, perPageRaw === null ? perPageDefault : Number(perPageRaw) || perPageDefault));
  const pageNum = Math.max(1, pageRaw === null ? 1 : Number(pageRaw) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'localhost';
    const makeUrl = (p: number): string => {
      const u = new URL(ctx.url.pathname, `http://${host}`);
      for (const [k, v] of ctx.url.searchParams) if (k !== 'page') u.searchParams.set(k, v);
      u.searchParams.set('page', String(p));
      return u.toString();
    };
    const lastPage = Math.max(1, Math.ceil(items.length / perPage));
    const links: string[] = [];
    if (pageNum < lastPage) links.push(`<${makeUrl(pageNum + 1)}>; rel="next"`);
    if (pageNum > 1) links.push(`<${makeUrl(pageNum - 1)}>; rel="prev"`);
    links.push(`<${makeUrl(1)}>; rel="first"`);
    links.push(`<${makeUrl(lastPage)}>; rel="last"`);
    headers.link = links.join(', ');
  }
  return { page, headers };
}

function restLabelJson(label: { id: number; name: string; color: string }): Json {
  return { id: label.id, name: label.name, color: label.color, default: false, url: 'x' };
}

function handleRest(ctx: Ctx, parts: string[]): void {
  const { method } = ctx;

  if (parts.length === 0 && method === 'GET') {
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issues_url: '/api/v3/repos/{owner}/{repo}/issues{?number,state,labels}',
      pulls_url: '/api/v3/repos/{owner}/{repo}/pulls{?number,state,head,base}',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, workflow, write:packages' });
    return;
  }
  if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
    sendJson(ctx, 200, { installed_version: FORGE_VERSION, version: FORGE_VERSION });
    return;
  }

  if (!ctx.authed) { sendError(ctx, 401, 'Requires authentication'); return; }

  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    sendJson(ctx, 200, { login: currentLogin(), id: 1, type: 'User', name: currentLogin() });
    return;
  }

  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const sorted = [...repos.values()].sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
      const { page, headers } = paginate(ctx, sorted.map(repoJson));
      sendJson(ctx, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const body = ctx.jsonBody;
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendError(ctx, 422, 'name is invalid'); return; }
      const repo = createRepo(name, body.private === undefined ? false : body.private === true,
        typeof body.description === 'string' ? body.description : '');
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
  }

  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = decodeURIComponent(parts[1]);
    const repoName = decodeURIComponent(parts[2]);
    const repo = lookupRepo(owner, repoName);
    if (repo === null) { sendError(ctx, 404, 'Not Found'); return; }
    const tail = parts.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') { sendJson(ctx, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        const body = ctx.jsonBody;
        if (typeof body.description === 'string') repo.description = body.description;
        if (body.private === true || body.private === false) repo.private = body.private;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        sendJson(ctx, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') { repos.delete(repo.name); sendRaw(ctx, 204, Buffer.alloc(0)); return; }
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
        sendJson(ctx, 200, branches);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = branchTip(repo, decodeURIComponent(tail[1]));
        if (sha === null) { sendError(ctx, 404, 'Branch not found'); return; }
        sendJson(ctx, 200, { name: decodeURIComponent(tail[1]), commit: { sha } });
        return;
      }
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const body = ctx.jsonBody;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/')) { sendError(ctx, 422, 'Reference name is invalid'); return; }
        if (!repo.objects.has(sha)) { sendError(ctx, 422, 'Object does not exist'); return; }
        if (repo.refs.has(ref)) { sendError(ctx, 422, 'Reference already exists'); return; }
        repo.refs.set(ref, sha);
        sendJson(ctx, 201, { ref, url: 'x', object: { sha, type: 'commit' } });
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const list = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, url: 'x', object: { sha, type: 'commit' } }));
        sendJson(ctx, 200, list);
        return;
      }
      if (tail.length >= 3 && method === 'GET') {
        const decoded = tail.slice(2).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(`refs/${decoded}`) ?? repo.refs.get(decoded);
        if (sha === undefined) { sendError(ctx, 404, 'Reference does not exist'); return; }
        sendJson(ctx, 200, { ref: `refs/${decoded}`, url: 'x', object: { sha, type: 'commit' } });
        return;
      }
    }

    if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
      const refName = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = branchTip(repo, refName) ?? repo.refs.get(refName) ?? (repo.objects.has(refName) ? refName : null);
      if (tip === null) { sendError(ctx, 404, 'Not Found'); return; }
      const commits = [...walkCommits(repo, [tip])].filter((oid) => repo.objects.get(oid)?.type === 'commit');
      // newest first: BFS from tip is roughly newest-first already
      const { page, headers } = paginate(ctx, commits);
      sendJson(ctx, 200, page.map((oid) => {
        const c = parseCommit(repo.objects.get(oid as string)!.data);
        return {
          sha: oid,
          commit: {
            message: 'x', tree: { sha: c.tree },
            author: { name: 'Forge', email: 'forge@make.fun', date: iso(Date.now()) },
            committer: { name: 'Forge', email: 'forge@make.fun', date: iso(Date.now()) },
          },
          parents: c.parents.map((p) => ({ sha: p, url: 'x' })),
          author: { login: currentLogin() }, committer: { login: currentLogin() },
          html_url: 'x', url: 'x',
        };
      }), headers);
      return;
    }

    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map(decodeURIComponent).join('/');
      if (method === 'PUT') { handleContentsPut(ctx, repo, filePath); return; }
      if (method === 'DELETE') { handleContentsDelete(ctx, repo, filePath); return; }
      if (method === 'GET') { handleContentsGet(ctx, repo, filePath); return; }
    }

    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'GET') { sendJson(ctx, 200, [...repo.labels.values()].map(restLabelJson)); return; }
      if (method === 'POST') {
        const body = ctx.jsonBody;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') { sendError(ctx, 422, 'name is required'); return; }
        if (repo.labels.has(name)) { sendError(ctx, 422, 'Label already exists'); return; }
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const label = { id: repo.labelSeq, name, color };
        repo.labelSeq += 1;
        repo.labels.set(name, label);
        sendJson(ctx, 201, restLabelJson(label));
        return;
      }
    }

    if (tail[0] === 'issues') {
      handleIssuesRoutes(ctx, repo, tail.slice(1));
      return;
    }
    if (tail[0] === 'pulls') {
      handlePullsRoutes(ctx, repo, tail.slice(1));
      return;
    }

    sendError(ctx, 404, 'Not Found');
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---- issues ----

function labelNamesFrom(body: Json): { ok: true; names: string[] } | { ok: false; bad: string } {
  if (!Array.isArray(body.labels)) return { ok: true, names: [] };
  const names: string[] = [];
  for (const entry of body.labels) {
    const labelName = typeof entry === 'string' ? entry : typeof (entry as Json)?.name === 'string' ? (entry as Json).name as string : '';
    if (labelName === '') return { ok: false, bad: labelName };
    names.push(labelName);
  }
  return { ok: true, names };
}

function handleIssuesRoutes(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()].filter((i) => i.state === state || state === 'all');
      list.sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt) || (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(ctx, list.map((i) => issueJson(repo, i)));
      sendJson(ctx, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const body = ctx.jsonBody;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') { sendError(ctx, 422, 'title is required'); return; }
      const labelRes = labelNamesFrom(body);
      if (!labelRes.ok) { sendError(ctx, 422, `Label "${labelRes.bad}" does not exist`); return; }
      for (const name of labelRes.names) {
        if (!repo.labels.has(name)) { sendError(ctx, 422, `Label "${name}" does not exist`); return; }
      }
      const now = Date.now();
      const issue: IssueRec = {
        id: repo.nextIssueId, number: repo.nextNumber, title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open', labels: labelRes.names, createdAt: now, updatedAt: now, comments: [],
      };
      repo.nextIssueId += 1;
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      sendJson(ctx, 201, issueJson(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue || issue.number !== number) { sendError(ctx, 404, 'Not Found'); return; }

  if (rest.length === 1) {
    if (method === 'GET') { sendJson(ctx, 200, issueJson(repo, issue)); return; }
    if (method === 'PATCH') {
      const body = ctx.jsonBody;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labelRes = labelNamesFrom(body);
        if (!labelRes.ok) { sendError(ctx, 422, `Label "${labelRes.bad}" does not exist`); return; }
        for (const name of labelRes.names) {
          if (!repo.labels.has(name)) { sendError(ctx, 422, `Label "${name}" does not exist`); return; }
        }
        issue.labels = labelRes.names;
      }
      issue.updatedAt = Date.now();
      sendJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: currentLogin() }, created_at: iso(c.createdAt), html_url: 'x', url: 'x' })));
      return;
    }
    if (method === 'POST') {
      const body = ctx.jsonBody;
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') { sendError(ctx, 422, 'body is required'); return; }
      const comment = { id: repo.nextCommentId, body: text, createdAt: Date.now() };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      issue.updatedAt = Date.now();
      sendJson(ctx, 201, { id: comment.id, body: comment.body, user: { login: currentLogin() }, created_at: iso(comment.createdAt), html_url: 'x', url: 'x' });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'labels' && method === 'GET') {
    sendJson(ctx, 200, issueJson(repo, issue).labels);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---- pulls ----

function handlePullsRoutes(ctx: Ctx, repo: Repo, rest: string[]): void {
  const { method } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()].filter((p) => p.state === state || state === 'all');
      list.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(ctx, list.map((p) => pullJson(repo, p)));
      sendJson(ctx, 200, page, headers);
      return;
    }
    if (method === 'POST') {
      const body = ctx.jsonBody;
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const title = typeof body.title === 'string' ? body.title : '';
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) {
        sendError(ctx, 422, `Head or base branch not found (head=${head}, base=${base})`);
        return;
      }
      if (head === base) { sendError(ctx, 422, 'head and base must differ'); return; }
      for (const existing of repo.pulls.values()) {
        if (existing.head === head && existing.state === 'open') {
          sendError(ctx, 422, `A pull request already exists for ${head}`);
          return;
        }
      }
      const mergeBase = findMergeBase(repo, headSha, baseSha);
      const files = diffTrees(repo, parseCommit(repo.objects.get(mergeBase)!.data).tree, parseCommit(repo.objects.get(headSha)!.data).tree);
      const pull: PullRec = {
        id: repo.nextIssueId + 5_000_000, number: repo.nextNumber, title,
        body: typeof body.body === 'string' ? body.body : '',
        head, base, headSha, baseSha, mergeBase,
        state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, files, createdAt: Date.now(),
      };
      repo.nextIssueId += 1;
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      sendJson(ctx, 201, pullJson(repo, pull));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!pull || pull.number !== number) { sendError(ctx, 404, 'Not Found'); return; }

  if (rest.length === 1) {
    if (method === 'GET') { sendJson(ctx, 200, pullJson(repo, pull)); return; }
    if (method === 'PATCH') { sendJson(ctx, 200, pullJson(repo, pull)); return; }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(ctx, 200, pull.files);
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.state === 'closed' && pull.merged) {
      sendError(ctx, 405, 'Pull Request is not open. state=closed');
      return;
    }
    if (mergeConflict(repo, pull)) {
      sendError(ctx, 405, 'Pull Request has conflicts that must be resolved before it can be merged');
      return;
    }
    const sha = squashMerge(repo, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso(Date.now());
    pull.mergeCommitSha = sha;
    sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---- contents ----

function resolveBlob(repo: Repo, branch: string, filePath: string): { sha: string; content: Buffer } | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  const files = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
  const blobOid = files.get(filePath);
  if (blobOid === undefined) return null;
  return { sha: blobOid, content: repo.objects.get(blobOid)!.data };
}

function handleContentsPut(ctx: Ctx, repo: Repo, filePath: string): void {
  if (filePath === '') { sendError(ctx, 422, 'path is required'); return; }
  const body = ctx.jsonBody;
  const contentB64 = typeof body.content === 'string' ? body.content.replace(/\s+/g, '') : '';
  let content: Buffer;
  try { content = Buffer.from(contentB64, 'base64'); } catch { sendError(ctx, 422, 'content is not valid base64'); return; }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Update file';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' && body.sha !== '' ? body.sha.toLowerCase() : null;
  const existing = resolveBlob(repo, branch, filePath);
  if (existing !== null && sha === null) {
    sendError(ctx, 422, `sha is required when updating an existing file (${filePath})`);
    return;
  }
  if (sha !== null) {
    if (existing === null) { sendError(ctx, 404, `${filePath} does not exist`); return; }
    if (existing.sha !== sha) { sendError(ctx, 409, `${filePath} does not match ${sha}`); return; }
  }
  const commitSha = commitFileChange(repo, branch, filePath, content, message);
  sendJson(ctx, existing === null ? 201 : 200, {
    content: {
      sha: hashObject('blob', content), name: filePath.split('/').pop()!, path: filePath,
      encoding: 'base64', type: 'file', size: content.length, url: 'x',
    },
    commit: {
      sha: commitSha, message, html_url: 'x', url: 'x',
      author: { name: 'Forge', email: 'forge@make.fun', date: iso(Date.now()) },
      committer: { name: 'Forge', email: 'forge@make.fun', date: iso(Date.now()) },
    },
  });
}

function handleContentsDelete(ctx: Ctx, repo: Repo, filePath: string): void {
  const body = ctx.jsonBody;
  const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const existing = resolveBlob(repo, branch, filePath);
  if (existing === null) { sendError(ctx, 404, `${filePath} does not exist`); return; }
  if (sha !== null && existing.sha !== sha) { sendError(ctx, 409, `${filePath} sha mismatch`); return; }
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'Delete file';
  const commitSha = commitFileChange(repo, branch, filePath, null, message);
  sendJson(ctx, 200, { content: null, commit: { sha: commitSha, message, html_url: 'x', url: 'x' } });
}

function handleContentsGet(ctx: Ctx, repo: Repo, filePath: string): void {
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, ref);
  if (tip === null) { sendError(ctx, 404, `No ref found for: ${ref}`); return; }
  let currentTree = parseCommit(repo.objects.get(tip)!.data).tree;
  const segments = filePath.split('/').filter((s) => s !== '');
  for (let i = 0; i < segments.length - 1; i += 1) {
    const entry = parseTree(repo.objects.get(currentTree)!.data).find((e) => e.name === segments[i]);
    if (!entry || entry.mode !== '40000') { sendError(ctx, 404, 'Not Found'); return; }
    currentTree = entry.oid;
  }
  const last = segments[segments.length - 1];
  const entry = parseTree(repo.objects.get(currentTree)!.data).find((e) => e.name === last);
  if (!entry) { sendError(ctx, 404, 'Not Found'); return; }
  if (entry.mode === '40000') {
    sendJson(ctx, 200, parseTree(repo.objects.get(entry.oid)!.data).map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name, path: `${filePath}/${e.name}`, sha: e.oid,
      size: e.mode === '40000' ? 0 : repo.objects.get(e.oid)!.data.length,
      url: 'x', git_url: 'x', html_url: 'x',
    })));
    return;
  }
  const obj = repo.objects.get(entry.oid)!;
  sendJson(ctx, 200, {
    type: 'file', name: last, path: filePath, sha: entry.oid, size: obj.data.length,
    encoding: 'base64', content: obj.data.toString('base64'),
    url: 'x', git_url: 'x', html_url: 'x', download_url: 'x',
  });
}

// ============================== git smart HTTP ==============================

function parseGitPath(pathname: string): { repo: string; action: string } | null {
  const m = /^\/[^/]+\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!m) return null;
  return { repo: decodeURIComponent(m[1]), action: m[2] };
}

function repoRefsOrdered(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.keys()].sort().map((name) => ({ name, oid: repo.refs.get(name)! }));
}

function peelTag(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

function serveInfoRefs(ctx: Ctx, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  const head = Buffer.concat([pkt(`# service=${service}\n`), FLUSH]);
  let body: Buffer;
  if (wantsV2) {
    body = Buffer.concat([
      pkt('version 2\n'),
      pkt(`agent=forge/${FORGE_VERSION}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow filter thin-pack ofs-delta side-band-64k\n'),
      pkt('object-format=sha1\n'),
      FLUSH,
    ]);
  } else {
    const upload = service === 'git-upload-pack';
    const caps = upload
      ? `multi_ack_detailed multi_ack side-band-64k side-band thin-pack ofs-delta shallow agent=forge/${FORGE_VERSION}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta atomic agent=forge/${FORGE_VERSION}`;
    const parts: Buffer[] = [];
    let first = true;
    if (upload && branchTip(repo, repo.defaultBranch) !== null) {
      parts.push(pkt(`${branchTip(repo, repo.defaultBranch)} HEAD\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}\n`));
      first = false;
    }
    for (const ref of repoRefsOrdered(repo)) {
      parts.push(pkt(first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
      first = false;
      const obj = repo.objects.get(ref.oid);
      if (obj && obj.type === 'tag') parts.push(pkt(`${peelTag(repo, ref.oid)} ${ref.name}^{}\n`));
    }
    if (first) parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    body = Buffer.concat([...parts, FLUSH]);
  }
  sendRaw(ctx, 200, Buffer.concat([head, body]), {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache',
  });
}

// ---- v2 upload-pack ----

function handleUploadPackV2(ctx: Ctx, repo: Repo, body: Buffer): void {
  // manual pkt decode to track delimiters
  let command = '';
  const argLines: string[] = [];
  let pastDelim = false;
  let offset = 0;
  let malformed = false;
  while (offset + 4 <= body.length) {
    const lenStr = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenStr)) { malformed = true; break; }
    const len = parseInt(lenStr, 16);
    if (len === 0) break;
    if (len === 1) { pastDelim = true; offset += 4; continue; }
    if (offset + len > body.length) { malformed = true; break; }
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    if (!pastDelim) {
      if (payload.startsWith('command=')) command = payload.slice(8).trim();
    } else {
      argLines.push(payload);
    }
  }
  if (malformed || command === '') {
    const err = Buffer.concat([pkt(command === '' ? 'ERR unknown command\n' : `ERR unknown command ${JSON.stringify(command)}\n`), FLUSH]);
    sendRaw(ctx, 200, err, { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of argLines) {
      const t = line.trim();
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t === 'unborn') unborn = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length).trim());
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const out: Buffer[] = [];
    const mainOid = branchTip(repo, repo.defaultBranch);
    if (mainOid !== null) {
      if (keep('HEAD')) {
        out.push(pkt(`${mainOid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      }
    } else if (unborn && keep('HEAD')) {
      out.push(pkt(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
    for (const ref of repoRefsOrdered(repo)) {
      if (!keep(ref.name)) continue;
      let extras = '';
      const obj = repo.objects.get(ref.oid);
      if (peel && obj && obj.type === 'tag') extras += ` peeled:${peelTag(repo, ref.oid)}`;
      out.push(pkt(`${ref.oid} ${ref.name}${extras}\n`));
    }
    out.push(FLUSH);
    sendRaw(ctx, 200, Buffer.concat(out), { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    return;
  }

  if (command === 'fetch') {
    serveFetchV2(ctx, repo, argLines);
    return;
  }

  sendRaw(ctx, 200, Buffer.concat([pkt(`ERR unknown command ${JSON.stringify(command)}\n`), FLUSH]),
    { 'content-type': 'application/x-git-upload-pack-result' });
}

interface FetchPlan { deliver: Map<string, GitObject>; shallow: string[]; unshallow: string[] }

function planFetch(repo: Repo, wants: string[], haves: string[], shallowReq: string[], depth: number | null): FetchPlan {
  // client-side object closure: haves' commits (stopping at client's shallow boundaries) + their trees/blobs
  const haveCommits = walkCommits(repo, haves, new Set(shallowReq));
  const haveObjects = new Set<string>(haveCommits);
  const expandTreeInto = (treeOid: string, into: Set<string>): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    into.add(treeOid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '160000') continue;
      into.add(e.oid);
      if (e.mode === '40000') expandTreeInto(e.oid, into);
    }
  };
  for (const oid of haveCommits) {
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') expandTreeInto(parseCommit(obj.data).tree, haveObjects);
  }
  // also treat non-commit wants/haves (tags, trees, blobs) the client claims
  for (const h of haves) {
    if (!repo.objects.has(h)) continue;
    haveObjects.add(h);
    const obj = repo.objects.get(h)!;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (repo.objects.has(target)) haveObjects.add(target);
    }
    if (obj.type === 'tree') expandTreeInto(h, haveObjects);
  }

  const deliver = new Map<string, GitObject>();
  const addTreeRec = (treeOid: string): void => {
    if (haveObjects.has(treeOid) || deliver.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj) return;
    deliver.set(treeOid, obj);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '160000' || haveObjects.has(e.oid)) continue;
      const child = repo.objects.get(e.oid);
      if (!child) continue;
      if (child.type === 'tree') addTreeRec(e.oid);
      else deliver.set(e.oid, child);
    }
  };
  const addCommitWithTree = (oid: string): void => {
    if (haveObjects.has(oid) || deliver.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    deliver.set(oid, obj);
    if (obj.type === 'commit') addTreeRec(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const tObj = repo.objects.get(target);
      if (tObj?.type === 'commit') addCommitWithTree(target);
      else if (tObj) { deliver.set(target, tObj); if (tObj.type === 'tree') addTreeRec(target); }
    } else if (obj.type === 'tree') addTreeRec(oid);
    else deliver.set(oid, obj);
  };

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    const commits = walkCommits(repo, wants, new Set(shallowReq));
    for (const oid of commits) {
      const obj = repo.objects.get(oid)!;
      if (obj.type === 'commit') addCommitWithTree(oid);
    }
    // tags wanted directly
    for (const w of wants) {
      const obj = repo.objects.get(w);
      if (obj && obj.type === 'tag') deliver.set(w, obj);
    }
    return { deliver, shallow: [], unshallow: [] };
  }

  // depth-limited BFS
  const reached = new Set<string>();
  interface QItem { oid: string; level: number }
  const queue: QItem[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      deliver.set(want, obj);
      const target = parseTag(obj.data).object;
      const tObj = repo.objects.get(target);
      if (tObj?.type === 'commit') queue.push({ oid: target, level: 1 });
      else if (tObj) { deliver.set(target, tObj); if (tObj.type === 'tree') addTreeRec(target); }
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, level: 1 });
    } else {
      addCommitWithTree(want);
    }
  }
  while (queue.length) {
    const { oid, level } = queue.shift()!;
    if (reached.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    reached.add(oid);
    // the client fully has this commit unless it declared it a shallow boundary
    const clientHasFull = haveObjects.has(oid) && !shallowReq.includes(oid);
    if (!clientHasFull) addCommitWithTree(oid);
    if (depth !== null && level >= depth) {
      if (!shallowReq.includes(oid)) shallow.push(oid);
      else unshallow.push(oid);
      continue;
    }
    if (shallowReq.includes(oid)) unshallow.push(oid);
    for (const p of parseCommit(obj.data).parents) {
      if (reached.has(p)) continue;
      if (haveObjects.has(p) && !shallowReq.includes(p)) {
        // client fully has this ancestor: not delivered, no need to walk
        continue;
      }
      queue.push({ oid: p, level: level + 1 });
    }
  }
  // any commit the client previously saw as boundary that we now deliver parents for is unshallowed;
  // boundaries we deliver at exactly the same depth stay boundaries (no line needed).
  console.error('[planFetch] deliver=', deliver.size, 'haveObjects=', haveObjects.size, 'reached=', reached.size, 'shallow=', shallow.length, 'unshallow=', unshallow.length);
  return { deliver, shallow, unshallow };
}

function serveFetchV2(ctx: Ctx, repo: Repo, argLines: string[]): void {
  let depth: number | null = null;
  let done = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowReq: string[] = [];
  for (const line of argLines) {
    const t = line.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('have ')) haves.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('shallow ')) shallowReq.push(t.slice(8));
    else if (t.startsWith('deepen ')) depth = Number(t.slice(7)) || null;
    else if (t === 'done') done = true;
  }
  const validWants = wants.filter((w) => repo.objects.has(w));
  console.error('[fetch-v2]', 'done=', done, 'haves=', haves.length, 'wants=', wants.length, 'depth=', depth, 'args=', JSON.stringify(argLines));
  if (!done) {
    // negotiation round: client will send more haves or 'done' next; answer with acknowledgments only
    const out: Buffer[] = [];
    if (haves.length > 0) {
      out.push(pkt('acknowledgments\n'));
      for (const h of haves) out.push(pkt(`ACK ${h}\n`));
      out.push(pkt('NAK\n'));
    }
    out.push(FLUSH);
    sendRaw(ctx, 200, Buffer.concat(out), { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    return;
  }
  const plan = validWants.length === 0
    ? { deliver: new Map<string, GitObject>(), shallow: [], unshallow: [] }
    : planFetch(repo, validWants, haves, shallowReq, depth);

  const pack = writePack([...plan.deliver.values()]);
  console.error('[fetch-pack] deliver=', plan.deliver.size, plan.deliver.size < 20 ? [...plan.deliver.keys()].join(',') : '', 'shallow=', plan.shallow.length, 'unshallow=', plan.unshallow.length);
  const sections: Buffer[][] = [];
  if (haves.length > 0 && !done) {
    sections.push([pkt('acknowledgments\n'), pkt('NAK\n')]);
  }
  if (depth !== null && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    const lines: Buffer[] = [pkt('shallow-info\n')];
    for (const oid of plan.shallow) lines.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) lines.push(pkt(`unshallow ${oid}\n`));
    sections.push(lines);
  }
  sections.push([pkt('packfile\n'), ...sidebandChunks(pack)]);
  const out2: Buffer[] = [];
  sections.forEach((section, idx) => {
    if (idx > 0) out2.push(DELIM);
    out2.push(...section);
  });
  out2.push(FLUSH);
  sendRaw(ctx, 200, Buffer.concat(out2), { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
}

function sidebandChunks(data: Buffer, maxPayload = 65515): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + maxPayload)])));
  }
  return chunks;
}

// ---- v0 upload-pack POST (fallback) ----

function handleUploadPackV0(ctx: Ctx, repo: Repo, body: Buffer): void {
  console.error('[fetch-v0] len=', body.length);
  const decoded = decodePktLinesSimple(body);
  if (decoded === null) {
    sendRaw(ctx, 400, Buffer.from('bad pkt-line\n'), { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const line of decoded) {
    const t = line.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('have ')) haves.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('deepen ')) depth = Number(t.slice(7)) || null;
    else if (t === 'done') done = true;
  }
  void done;
  const missing = wants.filter((w) => !repo.objects.has(w));
  if (missing.length > 0) {
    sendRaw(ctx, 200, Buffer.concat([pkt(`ERR upload-pack: not our ref ${missing[0]}\n`), FLUSH]),
      { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }
  const validWants = wants.filter((w) => repo.objects.has(w));
  const plan = validWants.length === 0
    ? { deliver: new Map<string, GitObject>(), shallow: [], unshallow: [] }
    : planFetch(repo, validWants, haves, [], depth);
  const pack = writePack([...plan.deliver.values()]);
  const out: Buffer[] = [];
  for (const oid of plan.shallow) out.push(pkt(`shallow ${oid}\n`));
  out.push(pkt('NAK\n'));
  for (const chunk of sidebandChunks(pack)) out.push(chunk);
  out.push(FLUSH);
  sendRaw(ctx, 200, Buffer.concat(out), { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
}

function decodePktLinesSimple(buf: Buffer): string[] | null {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenStr = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenStr)) return null;
    const len = parseInt(lenStr, 16);
    if (len === 0) { offset += 4; continue; }
    if (len === 1) { offset += 4; continue; }
    if (offset + len > buf.length) return null;
    lines.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
  return lines;
}

// ---- receive-pack ----

async function handleReceivePack(ctx: Ctx, repo: Repo, body: Buffer): Promise<void> {
  let offset = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capsRequested = new Set<string>();
  let first = true;
  for (;;) {
    if (offset + 4 > body.length) break;
    const lenStr = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenStr)) break;
    const len = parseInt(lenStr, 16);
    if (len === 0) { offset += 4; break; }
    const payload = body.subarray(offset + 4, offset + len);
    offset += len;
    let text = payload.toString('utf8');
    if (first) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        capsRequested = new Set(text.slice(nul + 1).trim().split(' ').filter(Boolean));
        text = text.slice(0, nul);
      }
      first = false;
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+?)\s*$/.exec(text);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(offset);
  console.error('[receive-pack]', JSON.stringify(commands), 'unpackPack=', packBytes.length, 'caps=', [...capsRequested]);

  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    if (packBytes.length > 0) {
      const objects = await readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (command.newOid === ZERO_OID) {
        if (!repo.refs.has(command.ref)) reason = 'ref not found';
        else if (current !== command.oldOid) reason = 'fetch first';
        else { repo.refs.delete(command.ref); ok = true; }
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'missing necessary objects';
      } else if (current === undefined) {
        if (command.oldOid !== ZERO_OID) reason = 'fetch first';
        else { repo.refs.set(command.ref, command.newOid); ok = true; }
      } else if (current !== command.oldOid) {
        reason = 'fetch first';
      } else if (command.oldOid === ZERO_OID) {
        reason = 'already exists';
      } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
        reason = 'non-fast-forward';
      } else {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
      reports.push({ ref: command.ref, ok, reason });
    }
  }

  console.error('[receive-pack] reports=', JSON.stringify(reports), 'unpackOk=', unpackOk, 'refs-after=', [...repo.refs.entries()]);
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const report of reports) {
    reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  const reportPkt = Buffer.concat([...reportLines.map((l) => pkt(l)), FLUSH]);

  const out: Buffer[] = [];
  if (capsRequested.has('side-band-64k')) {
    for (const chunk of sidebandChunks(reportPkt, 65000)) out.push(chunk);
    out.push(FLUSH);
  } else {
    out.push(reportPkt);
  }
  sendRaw(ctx, 200, Buffer.concat(out), { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
}

// ============================== GraphQL ==============================

class GqlSyntaxError extends Error {}

interface GqlField { alias: string | null; name: string; args: Map<string, unknown>; selections: GqlSelection[] }
type GqlSelection = GqlField | { fragment: true; typeCondition: string; selections: GqlSelection[] };
interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Map<string, { type: string; default: unknown }>;
  selections: GqlSelection[];
}

class GqlParser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) { this.text = text; }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '#') { while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1; continue; }
      if (/\s/.test(ch) || ch === ',') { this.pos += 1; continue; }
      break;
    }
  }

  private peek(): string { this.skipWs(); return this.text[this.pos] ?? ''; }

  private expect(ch: string): void {
    this.skipWs();
    if (this.text[this.pos] !== ch) throw new GqlSyntaxError(`expected '${ch}' at offset ${this.pos}`);
    this.pos += 1;
  }

  private name(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos])) this.pos += 1;
    if (start === this.pos) throw new GqlSyntaxError(`expected name at offset ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === ';') { this.pos += 1; continue; }
      const op = this.parseOperation();
      if (op === null) break;
      ops.push(op);
    }
    return ops;
  }

  private parseOperation(): GqlOperation | null {
    this.skipWs();
    const rest = this.text.slice(this.pos);
    if (rest.startsWith('{')) {
      return { type: 'query', name: null, varDefs: new Map(), selections: this.parseSelectionSet() };
    }
    if (/^query\b/.test(rest)) {
      this.pos += 5;
      return this.parseOpRest('query');
    }
    if (/^mutation\b/.test(rest)) {
      this.pos += 8;
      return this.parseOpRest('mutation');
    }
    return null;
  }

  private parseOpRest(type: 'query' | 'mutation'): GqlOperation {
    this.skipWs();
    let name: string | null = null;
    if (/[A-Za-z_]/.test(this.text[this.pos] ?? '')) name = this.name();
    const varDefs = new Map<string, { type: string; default: unknown }>();
    if (this.peek() === '(') {
      this.expect('(');
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.name();
        this.expect(':');
        const varType = this.parseTypeRef();
        let def: unknown = undefined;
        if (this.peek() === '=') { this.pos += 1; def = this.parseValue(); }
        varDefs.set(varName, { type: varType, default: def });
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  private skipDirectives(): void {
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] === '@') {
        this.pos += 1;
        this.name();
        if (this.peek() === '(') {
          let depth = 0;
          do {
            const ch = this.text[this.pos];
            if (ch === '(') depth += 1;
            else if (ch === ')') depth -= 1;
            this.pos += 1;
          } while (depth > 0 && this.pos < this.text.length);
        }
      } else break;
    }
  }

  private parseTypeRef(): string {
    this.skipWs();
    let type = '';
    if (this.text[this.pos] === '[') {
      this.pos += 1;
      type = `[${this.parseTypeRef()}]`;
      this.expect(']');
    } else {
      type = this.name();
    }
    if (this.text[this.pos] === '!') { type += '!'; this.pos += 1; }
    return type;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === '}') { this.expect('}'); break; }
      if (ch === '.') {
        this.pos += 1;
        this.expect('.');
        this.expect('.');
        this.skipWs();
        if (/^on\b/.test(this.text.slice(this.pos))) {
          this.pos += 2;
          const typeCondition = this.name();
          this.skipDirectives();
          selections.push({ fragment: true, typeCondition, selections: this.parseSelectionSet() });
        } else {
          this.name(); // fragment spread name (unused by the suite)
          this.skipDirectives();
          if (this.peek() === '{') this.parseSelectionSet();
        }
        continue;
      }
      selections.push(this.parseField());
    }
    return selections;
  }

  private parseField(): GqlField {
    const first = this.name();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.expect(':');
      alias = first;
      name = this.name();
    }
    const args = new Map<string, unknown>();
    if (this.peek() === '(') {
      this.expect('(');
      while (this.peek() !== ')') {
        const argName = this.name();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    this.skipDirectives();
    let selections: GqlSelection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.text[this.pos] ?? '';
    if (ch === '$') { this.pos += 1; return { __var: this.name() }; }
    if (ch === '"') return this.parseString();
    if (ch === '[') {
      this.pos += 1;
      const list: unknown[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (ch === '{') {
      this.pos += 1;
      const obj: Json = {};
      while (this.peek() !== '}') {
        const key = this.name();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.text.length && /[0-9.eE+-]/.test(this.text[this.pos])) this.pos += 1;
      return Number(this.text.slice(start, this.pos));
    }
    const word = this.name();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { __enum: word };
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        this.pos += 2;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === '"') out += '"';
        else if (next === '\\') out += '\\';
        else out += next ?? '';
        continue;
      }
      if (ch === '"') { this.pos += 1; return out; }
      out += ch;
      this.pos += 1;
    }
    throw new GqlSyntaxError('unterminated string');
  }
}

function derefVars(value: unknown, variables: Json): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => derefVars(v, variables));
  const obj = value as Json;
  if ('__var' in obj) {
    const name = obj.__var as string;
    return name in variables ? variables[name] : null;
  }
  if ('__enum' in obj) return obj.__enum as string;
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) out[k] = derefVars(v, variables);
  return out;
}

// ---- introspection schema ----

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'comments', 'labels', 'repository'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'body', 'files', 'author', 'url', 'mergedAt', 'mergeCommit', 'createdAt', 'repository', 'headRepository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'isPrivate', 'sshUrl', 'ref', 'refs'],
  User: ['id', 'login', 'name', 'email', 'url', 'createdAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions'],
  Ref: ['id', 'name', 'target', 'prefix'],
  RefConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge', 'subject'],
  RepositoryOwner: ['id', 'login'],
  Actor: ['id', 'login'],
  Node: ['id'],
  Label: ['id', 'name', 'color'],
  Commit: ['id', 'oid', 'message', 'abbreviatedOid'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function gqlIntrospectionType(name: string): Json | null {
  const fields = GQL_TYPE_FIELDS[name];
  const enums = GQL_ENUM_VALUES[name];
  if (fields === undefined && enums === undefined) return null;
  return {
    name,
    kind: enums !== undefined ? 'ENUM' : 'OBJECT',
    fields: fields === undefined ? null : fields.map((f) => ({
      name: f, description: null, args: [],
      type: { kind: 'SCALAR', name: 'String', ofType: null },
      isDeprecated: false, deprecationReason: null,
    })),
    enumValues: enums === undefined ? null : enums.map((e) => ({ name: e, description: null, isDeprecated: false, deprecationReason: null })),
    inputFields: null, interfaces: [], possibleTypes: null,
  };
}

// ---- GraphQL-facing views (lazy arg-driven fields are "$"-prefixed functions) ----

function gqlRepository(repo: Repo): Json {
  const dbId = repoIdOf(repo);
  const owner = repo.owner ?? currentLogin();
  const orderIssues = (args: Json): IssueRec[] => {
    let list = [...repo.issues.values()];
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    if (states && states.length > 0) {
      list = list.filter((i) => states.some((s) => String(s).toUpperCase() === i.state.toUpperCase()));
    }
    const orderBy = (args.orderBy ?? null) as Json | null;
    const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
    const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'DESC';
    return [...list].sort((a, b) => {
      const keyA = field === 'UPDATED_AT' ? a.updatedAt : field === 'COMMENTS' ? a.comments.length : a.createdAt;
      const keyB = field === 'UPDATED_AT' ? b.updatedAt : field === 'COMMENTS' ? b.comments.length : b.createdAt;
      const cmp = keyA === keyB ? b.number - a.number : keyA - keyB;
      return direction.toUpperCase() === 'ASC' ? cmp : -cmp;
    });
  };
  return {
    __typename: 'Repository',
    id: `R_${dbId}`, databaseId: dbId, name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    description: repo.description,
    owner: { __typename: 'User', login: owner, id: 'U_1' },
    defaultBranchRef: branchTip(repo, repo.defaultBranch) !== null
      ? { __typename: 'Ref', id: `R_${dbId}_head`, name: repo.defaultBranch }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    isPrivate: repo.private,
    createdAt: iso(repo.createdAt), updatedAt: iso(repo.createdAt),
    url: 'x', sshUrl: 'x',
    $issue: (args: Json): unknown => {
      const number = typeof args.number === 'number' ? args.number : Number(args.number ?? -1);
      const issue = repo.issues.get(number);
      return issue ? gqlIssue(repo, issue) : null;
    },
    $issues: (args: Json): unknown => {
      const ordered = orderIssues(args);
      const first = typeof args.first === 'number' ? args.first : ordered.length;
      const after = typeof args.after === 'string' && args.after !== '' ? Number(args.after) : -1;
      const start = after + 1;
      const slice = ordered.slice(start, start + first);
      return {
        __typename: 'IssueConnection',
        nodes: slice.map((i) => gqlIssue(repo, i)),
        edges: slice.map((i, idx) => ({ __typename: 'IssueEdge', node: gqlIssue(repo, i), cursor: String(start + idx) })),
        totalCount: ordered.length,
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: start + slice.length < ordered.length,
          hasPreviousPage: start > 0,
          endCursor: slice.length > 0 ? String(start + slice.length - 1) : String(after),
          startCursor: slice.length > 0 ? String(start) : null,
        },
      };
    },
    $pullRequest: (args: Json): unknown => {
      const number = typeof args.number === 'number' ? args.number : Number(args.number ?? -1);
      const pull = repo.pulls.get(number);
      return pull ? gqlPull(repo, pull) : null;
    },
    $pullRequests: (args: Json): unknown => {
      const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const slice = list.slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: slice.map((p) => gqlPull(repo, p)),
        edges: slice.map((p) => ({ __typename: 'PullRequestEdge', node: gqlPull(repo, p), cursor: String(p.number) })),
        totalCount: list.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first < list.length, hasPreviousPage: false, endCursor: slice.length ? String(slice[slice.length - 1].number) : null, startCursor: null },
      };
    },
  };
}

function gqlIssue(repo: Repo, issue: IssueRec): Json {
  void repo;
  return {
    __typename: 'Issue',
    id: `I_${issue.id}`, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state.toUpperCase(),
    author: { __typename: 'User', login: currentLogin(), id: 'U_1' },
    createdAt: iso(issue.createdAt), updatedAt: iso(issue.updatedAt),
    closedAt: issue.state === 'closed' ? iso(issue.updatedAt) : null,
    url: 'x',
    labels: issue.labels.map((name) => ({ __typename: 'Label', id: `L_${name}`, name })),
    comments: { __typename: 'IssueCommentConnection', totalCount: issue.comments.length, nodes: [], edges: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null } },
  };
}

function gqlPull(repo: Repo, pull: PullRec): Json {
  void repo;
  return {
    __typename: 'PullRequest',
    id: `PR_${pull.id}`, number: pull.number, title: pull.title, body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: 'MERGEABLE',
    headRefName: pull.head, baseRefName: pull.base,
    author: { __typename: 'User', login: currentLogin(), id: 'U_1' },
    createdAt: iso(pull.createdAt), mergedAt: pull.mergedAt,
    url: 'x',
    mergeCommit: pull.mergeCommitSha !== null ? { __typename: 'Commit', oid: pull.mergeCommitSha, id: `C_${pull.mergeCommitSha}` } : null,
    headRepository: null,
    $files: (args: Json): unknown => {
      const first = typeof args.first === 'number' ? args.first : pull.files.length;
      const slice = pull.files.slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: slice.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions })),
        edges: slice.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions })),
        totalCount: pull.files.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: first < pull.files.length, hasPreviousPage: false, endCursor: null, startCursor: null },
      };
    },
  };
}

function repoByGlobalId(id: string): Repo | null {
  const dbId = Number(/^R_(\d+)/.exec(id)?.[1] ?? NaN);
  if (!Number.isFinite(dbId)) return null;
  for (const repo of repos.values()) if (repoIdOf(repo) === dbId) return repo;
  return null;
}

function issueByGlobalId(id: string): IssueRec | null {
  const issueId = Number(/^I_(\d+)/.exec(id)?.[1] ?? NaN);
  if (!Number.isFinite(issueId)) return null;
  for (const repo of repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === issueId) return issue;
  }
  return null;
}

function pullByGlobalId(id: string): { pull: PullRec; repo: Repo } | null {
  const pullId = Number(/^PR_(\d+)/.exec(id)?.[1] ?? NaN);
  if (!Number.isFinite(pullId)) return null;
  for (const repo of repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === pullId) return { pull, repo };
  }
  return null;
}

function resolveNode(id: string): Json | null {
  const repo = repoByGlobalId(id);
  if (repo !== null) {
    const full = gqlRepository(repo);
    return { __typename: 'Repository', id: full.id, name: full.name, nameWithOwner: full.nameWithOwner, databaseId: full.databaseId };
  }
  const issue = issueByGlobalId(id);
  if (issue !== null) return { __typename: 'Issue', id: `I_${issue.id}` };
  const pr = pullByGlobalId(id);
  if (pr !== null) return { __typename: 'PullRequest', id: `PR_${pr.pull.id}` };
  if (id === 'U_1') return { __typename: 'User', id, login: currentLogin() };
  return null;
}

// ---- executor ----

class GqlExecutor {
  readonly errors: Json[] = [];

  execute(req: { query: string; variables: Json; operationName: string | null }): Json {
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(req.query).parseDocument();
    } catch (err) {
      return { errors: [{ message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    if (ops.length === 0) return { errors: [{ message: 'No operations in query' }] };
    let op = ops[0]!;
    if (req.operationName !== null) {
      const found = ops.find((o) => o.name === req.operationName);
      if (!found) return { errors: [{ message: `Unknown operation named "${req.operationName}"` }] };
      op = found;
    }
    const variables = { ...req.variables };
    for (const [name, def] of op.varDefs) {
      if (!(name in variables) && def.default !== undefined) variables[name] = def.default;
    }
    const data = this.executeSelections(op.selections, null, 'Query', op.type, variables);
    if (this.errors.length === 0) return { data };
    return { data, errors: this.errors };
  }

  private executeSelections(selections: GqlSelection[], parent: unknown, parentType: string, rootType: 'query' | 'mutation', variables: Json): Json {
    const out: Json = {};
    for (const selection of selections) {
      if ('fragment' in selection) {
        if (selection.typeCondition === parentType || (selection.typeCondition === 'Node' && ['Repository', 'Issue', 'PullRequest', 'User'].includes(parentType)) || (['RepositoryOwner', 'Actor'].includes(selection.typeCondition) && parentType === 'User')) {
          Object.assign(out, this.executeSelections(selection.selections, parent, selection.typeCondition, rootType, variables));
        }
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') { out[key] = parentType; continue; }
      const args = derefVars(Object.fromEntries(selection.args), variables) as Json;
      try {
        const resolved = this.resolveField(selection.name, args, parent, parentType, rootType, variables);
        if (resolved === undefined) {
          this.errors.push({ message: `The field \`${selection.name}\` does not exist on type \`${parentType}\`.` });
          out[key] = null;
          continue;
        }
        out[key] = this.project(resolved, selection.selections, selection.name, rootType, variables);
      } catch (err) {
        this.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
      }
    }
    return out;
  }

  private resolveField(field: string, args: Json, parent: unknown, parentType: string, rootType: 'query' | 'mutation', variables: Json): unknown {
    if (parentType === 'Query' || parentType === 'Mutation') {
      if (field === '__type' || field === '__schema') return this.introspect(field, args);
      if (rootType === 'mutation') return this.resolveMutation(field, args);
      return this.resolveQueryField(field, args);
    }
    const record = (parent ?? {}) as Json;
    if (field === '__type' || field === '__schema') {
      return this.introspect(field, args);
    }
    if (field in record) {
      const value = record[field];
      if (typeof value === 'function') return (value as (a: Json) => unknown)(args);
      return value;
    }
    const lazyKey = `$${field}`;
    if (lazyKey in record) return (record[lazyKey] as (a: Json) => unknown)(args);
    return undefined;
  }

  private introspect(field: string, args: Json): unknown {
    if (field === '__schema') {
      return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [], directives: [] };
    }
    const name = typeof args.name === 'string' ? args.name : '';
    const type = gqlIntrospectionType(name);
    if (type === null) return null;
    return { __typename: '__Type', ...type };
  }

  private resolveQueryField(field: string, args: Json): unknown {
    switch (field) {
      case 'viewer':
        return { __typename: 'User', login: currentLogin(), id: 'U_1', name: currentLogin() };
      case 'repository': {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = owner === '' ? null : lookupRepo(owner, name);
        return repo === null ? null : gqlRepository(repo);
      }
      case 'node': {
        const id = typeof args.id === 'string' ? args.id : '';
        return resolveNode(id);
      }
      default:
        return undefined;
    }
  }

  private resolveMutation(field: string, args: Json): unknown {
    const input = (args.input ?? {}) as Json;
    switch (field) {
      case 'createIssue': {
        const repo = repoByGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        if (repo === null) throw new Error(`Could not resolve to a node with the global id of '${String(input.repositoryId ?? '')}'`);
        const now = Date.now();
        const issue: IssueRec = {
          id: repo.nextIssueId, number: repo.nextNumber,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open', labels: [], createdAt: now, updatedAt: now, comments: [],
        };
        repo.nextIssueId += 1;
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        return { issue: gqlIssue(repo, issue) };
      }
      case 'closeIssue': {
        const found = issueByGlobalId(typeof input.issueId === 'string' ? input.issueId : '');
        if (found === null) throw new Error(`Could not resolve to a node with the global id of '${String(input.issueId ?? '')}'`);
        found.state = 'closed';
        found.updatedAt = Date.now();
        return { issue: { __typename: 'Issue', id: `I_${found.id}`, number: found.number, state: 'CLOSED' } };
      }
      case 'updateIssue': {
        const found = issueByGlobalId(typeof input.id === 'string' ? input.id : '');
        if (found === null) return { issue: null };
        if (input.state === 'OPEN') found.state = 'open';
        if (input.state === 'CLOSED') found.state = 'closed';
        return { issue: { __typename: 'Issue', id: `I_${found.id}`, number: found.number, state: found.state.toUpperCase() } };
      }
      case 'createPullRequest': {
        const repo = repoByGlobalId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        if (repo === null) throw new Error(`Could not resolve to a node with the global id of '${String(input.repositoryId ?? '')}'`);
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = branchTip(repo, head);
        const baseSha = branchTip(repo, base);
        if (headSha === null || baseSha === null) throw new Error(`Head or base ref not found (${head} -> ${base})`);
        const files = diffTrees(repo, parseCommit(repo.objects.get(findMergeBase(repo, headSha, baseSha))!.data).tree, parseCommit(repo.objects.get(headSha)!.data).tree);
        const pull: PullRec = {
          id: repo.nextIssueId + 5_000_000, number: repo.nextNumber,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head, base, headSha, baseSha, mergeBase: findMergeBase(repo, headSha, baseSha),
          state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, files, createdAt: Date.now(),
        };
        repo.nextIssueId += 1;
        repo.nextNumber += 1;
        repo.pulls.set(pull.number, pull);
        return { pullRequest: gqlPull(repo, pull) };
      }
      case 'mergePullRequest': {
        const id = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
        const found = pullByGlobalId(id);
        if (found === null) throw new Error(`Could not resolve to a node with the global id of '${id}'`);
        const { pull, repo } = found;
        if (pull.state === 'closed' && pull.merged) throw new Error('Pull request is already merged');
        if (mergeConflict(repo, pull)) throw new Error('Pull Request has conflicts that must be resolved before it can be merged');
        const sha = squashMerge(repo, pull);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = iso(Date.now());
        pull.mergeCommitSha = sha;
        return { pullRequest: { __typename: 'PullRequest', id: `PR_${pull.id}`, number: pull.number, merged: true, state: 'MERGED' } };
      }
      case 'addComment': {
        const found = issueByGlobalId(typeof input.subjectId === 'string' ? input.subjectId : '');
        if (found === null) throw new Error(`Could not resolve to a node with the global id of '${String(input.subjectId ?? '')}'`);
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = { id: 900000 + found.id * 10 + found.comments.length + 1, body, createdAt: Date.now() };
        found.comments.push(comment);
        found.updatedAt = Date.now();
        return { commentEdge: { __typename: 'CommentEdge', node: { __typename: 'IssueComment', id: `C_${comment.id}`, body: comment.body } } };
      }
      default:
        return undefined;
    }
  }

  private project(value: unknown, selections: GqlSelection[], fieldName: string, rootType: 'query' | 'mutation', variables: Json): unknown {
    if (selections.length === 0) return value === undefined ? null : value;
    if (value === null) return null;
    if (Array.isArray(value)) return value.map((item) => this.project(item, selections, fieldName, rootType, variables));
    if (typeof value !== 'object') return value;
    const typeName = ((value as Json).__typename as string | undefined) ?? this.inferTypeName(fieldName);
    return this.executeSelections(selections, value, typeName, rootType, variables);
  }

  private inferTypeName(fieldName: string): string {
    switch (fieldName) {
      case 'viewer': case 'owner': case 'author': return 'User';
      case 'repository': case 'headRepository': return 'Repository';
      case 'issue': return 'Issue';
      case 'issues': return 'IssueConnection';
      case 'pullRequest': return 'PullRequest';
      case 'pullRequests': return 'PullRequestConnection';
      case 'files': return 'PullRequestChangedFileConnection';
      case 'defaultBranchRef': case 'ref': return 'Ref';
      case 'pageInfo': return 'PageInfo';
      case 'nodes': case 'edges': return 'Issue';
      case 'node': return 'Node';
      case 'mergeCommit': return 'Commit';
      case 'commentEdge': return 'CommentEdge';
      default: return 'Object';
    }
  }
}

function handleGraphQL(ctx: Ctx, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const runOne = (req: Json): Json => {
    const query = typeof req.query === 'string' ? req.query : '';
    const variables = (req.variables ?? null) as Json | null;
    const operationName = typeof req.operationName === 'string' ? req.operationName : null;
    return new GqlExecutor().execute({ query, variables: variables ?? {}, operationName });
  };
  if (Array.isArray(parsed)) {
    sendJson(ctx, 200, parsed.map((req) => runOne((req ?? {}) as Json)));
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(ctx, 200, { errors: [{ message: 'The query must be a string' }] });
    return;
  }
  sendJson(ctx, 200, runOne(parsed as Json));
}

// ============================== MCP ==============================

interface McpToolDef {
  name: string; title: string; description: string;
  inputSchema: Json; required: string[];
}

const MCP_TOOLS: McpToolDef[] = [
  { name: 'create_repo', title: 'Create repository', description: 'Create a new repository', required: ['name'], inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'repository name' }, description: { type: 'string', description: 'description' }, private: { type: 'boolean', description: 'private flag' } } } },
  { name: 'get_repo', title: 'Get repository', description: 'Get repository details', required: ['owner', 'repo'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, full_name: { type: 'string', description: 'owner/repo' } } } },
  { name: 'create_issue', title: 'Create issue', description: 'Create an issue', required: ['owner', 'repo', 'title'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, title: { type: 'string', description: 'title' }, body: { type: 'string', description: 'body' } } } },
  { name: 'list_issues', title: 'List issues', description: 'List issues', required: ['owner', 'repo'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, state: { type: 'string', description: 'state filter' } } } },
  { name: 'get_issue', title: 'Get issue', description: 'Read one issue', required: ['owner', 'repo', 'issue_number'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, issue_number: { type: 'number', description: 'issue number' } } } },
  { name: 'update_issue', title: 'Update issue', description: 'Update an issue', required: ['owner', 'repo', 'issue_number'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, issue_number: { type: 'number', description: 'issue number' }, state: { type: 'string', description: 'new state' } } } },
  { name: 'create_pull_request', title: 'Create pull request', description: 'Open a pull request', required: ['owner', 'repo', 'title', 'head', 'base'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, title: { type: 'string', description: 'title' }, body: { type: 'string', description: 'body' }, head: { type: 'string', description: 'head branch' }, base: { type: 'string', description: 'base branch' } } } },
  { name: 'list_pull_requests', title: 'List pull requests', description: 'List pull requests', required: ['owner', 'repo'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, state: { type: 'string', description: 'state filter' } } } },
  { name: 'merge_pull_request', title: 'Merge pull request', description: 'Merge a pull request', required: ['owner', 'repo', 'pull_number'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, pull_number: { type: 'number', description: 'pull request number' } } } },
  { name: 'create_branch', title: 'Create branch', description: 'Create a branch ref at a commit', required: ['owner', 'repo', 'branch', 'sha'], inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'owner' }, repo: { type: 'string', description: 'name' }, branch: { type: 'string', description: 'branch name' }, sha: { type: 'string', description: 'commit sha' } } } },
];

const MCP_TOOLS_JSON = JSON.stringify({
  tools: MCP_TOOLS.map((tool) => ({
    name: tool.name, title: tool.title, description: tool.description,
    inputSchema: { ...tool.inputSchema, required: [...tool.required] },
  })),
});

function findRepoForTool(args: Json): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if (name === '' && full.includes('/')) {
    const idx = full.indexOf('/');
    return lookupRepo(full.slice(0, idx), full.slice(idx + 1));
  }
  if (owner === '') return repos.get(name) ?? null;
  return lookupRepo(owner, name);
}

function textResult(payload: Json): Json {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
function errorResult(message: string): Json {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function mcpCallTool(name: string, args: Json): Json {
  switch (name) {
    case 'create_repo': {
      const nameArg = String(args.name);
      const priv = args.private === undefined ? true : args.private === true;
      const repo = createRepo(nameArg, priv, typeof args.description === 'string' ? args.description : '');
      const json = repoJson(repo);
      return textResult({ ...json, full_name: json.full_name });
    }
    case 'get_repo': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      const now = Date.now();
      const issue: IssueRec = {
        id: repo.nextIssueId, number: repo.nextNumber, title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels: [], createdAt: now, updatedAt: now, comments: [],
      };
      repo.nextIssueId += 1;
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return textResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.number - a.number);
      return textResult(list.map((i) => issueJson(repo, i)));
    }
    case 'get_issue':
    case 'update_issue': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      const number = Number(args.issue_number ?? -1);
      const issue = repo.issues.get(number);
      if (!issue) return errorResult('Not Found');
      if (name === 'update_issue') {
        const state = String(args.state ?? '').toLowerCase();
        if (state === 'open' || state === 'closed') issue.state = state;
        if (typeof args.title === 'string') issue.title = args.title;
        if (typeof args.body === 'string') issue.body = args.body;
        issue.updatedAt = Date.now();
      }
      return textResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) return errorResult(`Head or base branch not found (head=${head}, base=${base})`);
      const files = diffTrees(repo, parseCommit(repo.objects.get(findMergeBase(repo, headSha, baseSha))!.data).tree, parseCommit(repo.objects.get(headSha)!.data).tree);
      const pull: PullRec = {
        id: repo.nextIssueId + 5_000_000, number: repo.nextNumber, title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head, base, headSha, baseSha, mergeBase: findMergeBase(repo, headSha, baseSha),
        state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, files, createdAt: Date.now(),
      };
      repo.nextIssueId += 1;
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return textResult(pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      return textResult(list.map((p) => pullJson(repo, p)));
    }
    case 'merge_pull_request': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      const number = Number(args.pull_number ?? -1);
      const pull = repo.pulls.get(number);
      if (!pull) return errorResult('Not Found');
      if (pull.state === 'closed' && pull.merged) return errorResult('Pull request already merged');
      if (mergeConflict(repo, pull)) return errorResult('Pull Request has conflicts that must be resolved before it can be merged');
      const sha = squashMerge(repo, pull);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = iso(Date.now());
      pull.mergeCommitSha = sha;
      return textResult({ ...pullJson(repo, pull), merged: true, sha });
    }
    case 'create_branch': {
      const repo = findRepoForTool(args);
      if (repo === null) return errorResult('Not Found');
      const branch = String(args.branch ?? '');
      const sha = String(args.sha ?? '');
      if (!repo.objects.has(sha)) return errorResult('Object does not exist');
      const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
      if (repo.refs.has(ref)) return errorResult('Reference already exists');
      repo.refs.set(ref, sha);
      return textResult({ ref, object: { sha } });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpHandleOne(req: Json): Json | null {
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Json;
  if (id === undefined || id === null) return null; // notification
  const reply = (result: Json): Json => ({ jsonrpc: '2.0', id, result });
  const replyError = (code: number, message: string): Json => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const version = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_SUPPORTED_VERSIONS[0];
    return reply({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-forge', version: FORGE_VERSION },
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests.',
    });
  }
  if (method === 'server/discover') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (requested !== '' && !MCP_SUPPORTED_VERSIONS.includes(requested)) {
      return replyError(-32022, `Unsupported protocol version: ${requested}`);
    }
    return reply({
      resultType: 'discoverResult',
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      instructions: 'A GitHub-compatible forge.',
      serverInfo: { name: 'makefun-forge', version: FORGE_VERSION },
    });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply(JSON.parse(MCP_TOOLS_JSON) as Json);
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) return replyError(-32602, `Unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as Json;
    const missing = tool.required.filter((r) => !(r in args) || args[r] === undefined || args[r] === null);
    if (missing.length > 0) return replyError(-32602, `Missing required arguments: ${missing.join(', ')}`);
    try {
      return reply(mcpCallTool(name, args));
    } catch (err) {
      return reply(errorResult(err instanceof Error ? err.message : String(err)));
    }
  }
  return replyError(-32601, `Method not found: ${method}`);
}

function handleMcp(ctx: Ctx, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const replies = (parsed as Json[])
      .filter((r) => r !== null && typeof r === 'object')
      .map((r) => mcpHandleOne(r as Json))
      .filter((r) => r !== null);
    sendJson(ctx, 200, replies);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const reply = mcpHandleOne(parsed as Json);
  if (reply === null) { sendRaw(ctx, 202, Buffer.alloc(0)); return; }
  sendJson(ctx, 200, reply);
}

// ============================== dispatch ==============================

async function handle(ctx: Ctx): Promise<void> {
  const pathname = ctx.url.pathname;

  if (pathname === '/healthz' && ctx.method === 'GET') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  const gitPath = parseGitPath(pathname);
  if (gitPath !== null) {
    const repo = repos.get(gitPath.repo);
    if (repo === undefined) { sendError(ctx, 404, 'Not Found'); return; }
    if (ctx.method === 'GET' && gitPath.action === 'info/refs') {
      const service = ctx.url.searchParams.get('service');
      if (service === 'git-upload-pack') { serveInfoRefs(ctx, repo, 'git-upload-pack'); return; }
      if (service === 'git-receive-pack') { serveInfoRefs(ctx, repo, 'git-receive-pack'); return; }
      sendError(ctx, 403, 'smart HTTP service required');
      return;
    }
    if (ctx.method === 'POST' && gitPath.action === 'git-upload-pack') {
      const body = await readBody(ctx);
      if ((ctx.req.headers['git-protocol'] ?? '').includes('version=2')) handleUploadPackV2(ctx, repo, body);
      else handleUploadPackV0(ctx, repo, body);
      return;
    }
    if (ctx.method === 'POST' && gitPath.action === 'git-receive-pack') {
      const body = await readBody(ctx);
      await handleReceivePack(ctx, repo, body);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (pathname === '/api/graphql') {
    if (!ctx.authed) { sendError(ctx, 401, 'Requires authentication'); return; }
    if (ctx.method !== 'POST') { sendError(ctx, 405, 'Method Not Allowed'); return; }
    const body = await readBody(ctx);
    handleGraphQL(ctx, body);
    return;
  }

  if (pathname === '/mcp') {
    if (!ctx.authed) { sendError(ctx, 401, 'Requires authentication'); return; }
    const body = await readBody(ctx);
    handleMcp(ctx, body);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    let jsonBody: Json = {};
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      const rawBody = await readBody(ctx);
      if (rawBody.length > 0) {
        try {
          jsonBody = JSON.parse(rawBody.toString('utf8')) as Json;
        } catch {
          sendError(ctx, 400, 'Problems parsing JSON');
          return;
        }
      }
    }
    ctx.jsonBody = jsonBody;
    handleRest(ctx, pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/').filter((s) => s !== ''));
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry.local');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const authHeader = req.headers.authorization ?? '';
    const authed = process.env.MAKEFUN_DEBUG_AUTH === '1' ? authHeader.startsWith('Bearer ') : TOKEN !== '' && authHeader === `Bearer ${TOKEN}`;
    const ctx: Ctx = { req, res, url, method: (req.method ?? 'GET').toUpperCase(), authed, jsonBody: {} };
    handle(ctx).catch((err) => {
      console.error('[500]', err instanceof Error ? err.stack : err);
      try { sendError(ctx, 500, err instanceof Error ? err.message : 'Internal error'); } catch { /* socket gone */ }
    });
  });
}
