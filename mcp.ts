// MCP Streamable HTTP handler (JSON-RPC 2.0), deterministic and synchronous.
import { createHash } from 'node:crypto';
import { ForgeStore, type Issue, type Pull, type Repo } from './store.ts';

const SUPPORTED_VERSIONS = ['2025-11-25', '2026-07-28'];
const LATEST_VERSION = '2026-07-28';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, string>,
  required: string[] = [],
): ToolDefinition {
  const schema: ToolDefinition['inputSchema'] = {
    type: 'object',
    properties: {},
    required,
  };
  for (const [key, desc] of Object.entries(properties)) {
    schema.properties[key] = { type: key === 'pull_number' || key === 'issue_number' ? 'integer' : 'string', description: desc };
  }
  return { name, description, inputSchema: schema };
}

const TOOLS: ToolDefinition[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: 'Repository name', description: 'Optional repository description', private: 'Whether the repository is private',
  }, ['name']),
  tool('get_repo', 'Read a repository by owner and name.', {
    owner: 'Repository owner login', repo: 'Repository name',
  }, ['owner', 'repo']),
  tool('create_issue', 'Open a new issue in a repository.', {
    owner: 'Repository owner login', repo: 'Repository name', title: 'Issue title', body: 'Issue body', labels: 'Comma separated labels',
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository, optionally filtered by state.', {
    owner: 'Repository owner login', repo: 'Repository name', state: 'open, closed or all',
  }, ['owner', 'repo']),
  tool('get_issue', 'Read one issue by its number.', {
    owner: 'Repository owner login', repo: 'Repository name', issue_number: 'Issue number',
  }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Open a pull request between two branches of a repository.', {
    owner: 'Repository owner login', repo: 'Repository name', title: 'Pull request title',
    head: 'Head branch name', base: 'Base branch name', body: 'Pull request body',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('get_pull_request', 'Read one pull request by its number.', {
    owner: 'Repository owner login', repo: 'Repository name', pull_number: 'Pull request number',
  }, ['owner', 'repo', 'pull_number']),
  tool('list_pull_requests', 'List pull requests in a repository.', {
    owner: 'Repository owner login', repo: 'Repository name', state: 'open, closed, merged or all',
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Merge a pull request into its base branch.', {
    pull_number: 'Pull request number', owner: 'Optional repository owner', repo: 'Optional repository name',
    merge_method: 'merge, squash or rebase',
  }, ['pull_number']),
  tool('create_label', 'Create a label in a repository.', {
    owner: 'Repository owner login', repo: 'Repository name', name: 'Label name', color: 'Six digit hex colour',
  }, ['owner', 'repo', 'name']),
  tool('create_file', 'Create or update a file and commit it to a branch.', {
    owner: 'Repository owner login', repo: 'Repository name', path: 'File path', content: 'File contents',
    message: 'Commit message', branch: 'Target branch',
  }, ['owner', 'repo', 'path', 'content']),
];

const TOOLS_RESULT_JSON = JSON.stringify({ tools: TOOLS });
const SESSION_ID = `mcp-${createHash('sha1').update('forge-session').digest('hex').slice(0, 16)}`;

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: string): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${result}}`;
}

function rpcError(id: unknown, code: number, message: string): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
}

function toolError(message: string): string {
  return JSON.stringify({ content: [{ type: 'text', text: message }], isError: true });
}

function toolSuccess(data: unknown): string {
  return JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(data) }] });
}

function numberArg(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : -1;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toLowerCase(),
    labels: issue.labels,
    repository: `${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state.toLowerCase(),
    head: pull.head,
    base: pull.base,
    mergeable: false, // filled in by the caller when needed
    merged: pull.merged,
    repository: `${repo.owner}/${repo.name}`,
  };
}

function findTool(name: unknown): ToolDefinition | undefined {
  const wanted = String(name || '').toLowerCase();
  return TOOLS.find((entry) => {
    const canonical = entry.name.toLowerCase();
    return (
      wanted === canonical ||
      wanted.endsWith(`_${canonical}`) ||
      wanted.endsWith(`.${canonical}`) ||
      wanted.endsWith(`-${canonical}`) ||
      wanted.endsWith(`:${canonical}`)
    );
  });
}

function callTool(store: ForgeStore, rawName: unknown, rawArgs: unknown): string {
  const definition = findTool(rawName);
  if (!definition) return toolError(`Unknown tool: ${String(rawName)}`);
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : {};
  for (const required of definition.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  try {
    switch (definition.name) {
      case 'create_repo': {
        const repo = store.createRepo(
          store.login,
          String(args.name),
          String(args.description || ''),
          Boolean(args.private),
        );
        return toolSuccess(repoJson(repo));
      }
      case 'get_repo': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        return repo ? toolSuccess(repoJson(repo)) : toolError('Repository not found');
      }
      case 'create_issue': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError('Repository not found');
        const labelsArg = args.labels;
        const labels = Array.isArray(labelsArg)
          ? labelsArg.map(String)
          : labelsArg
            ? String(labelsArg).split(',').map((s) => s.trim()).filter(Boolean)
            : [];
        const issue = store.createIssue(repo, String(args.title), String(args.body || ''), labels);
        return toolSuccess(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError('Repository not found');
        const state = String(args.state || 'all').toLowerCase();
        const issues = [...repo.issues.values()]
          .filter((issue) => state === 'all' || issue.state.toLowerCase() === state)
          .sort((a, b) => b.number - a.number)
          .map((issue) => issueJson(repo, issue));
        return toolSuccess(issues);
      }
      case 'get_issue': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        const issue = repo?.issues.get(numberArg(args.issue_number));
        return issue && repo ? toolSuccess(issueJson(repo, issue)) : toolError('Issue not found');
      }
      case 'create_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError('Repository not found');
        const head = String(args.head);
        const base = String(args.base || repo.defaultBranch);
        if (!store.resolve(repo, head) || !store.resolve(repo, base)) return toolError('Branch not found');
        const pull = store.createPull(repo, String(args.title), head, base, String(args.body || ''));
        return toolSuccess({
          ...pullJson(repo, pull),
          mergeable: store.mergeable(repo, pull),
          changed_files: pull.files.length,
        });
      }
      case 'get_pull_request': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        const pull = repo?.pulls.get(numberArg(args.pull_number));
        return pull && repo
          ? toolSuccess({ ...pullJson(repo, pull), mergeable: store.mergeable(repo, pull) })
          : toolError('Pull request not found');
      }
      case 'list_pull_requests': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError('Repository not found');
        const state = String(args.state || 'all').toLowerCase();
        const pulls = [...repo.pulls.values()]
          .filter((pull) => state === 'all' || pull.state.toLowerCase() === state)
          .sort((a, b) => b.number - a.number)
          .map((pull) => ({ ...pullJson(repo, pull), mergeable: store.mergeable(repo, pull) }));
        return toolSuccess(pulls);
      }
      case 'merge_pull_request': {
        const number = numberArg(args.pull_number);
        let entry = store.pullsByNumber.get(number);
        if (args.owner && args.repo) {
          const scoped = store.getRepo(String(args.owner), String(args.repo));
          if (scoped?.pulls.get(number)) entry = { repo: scoped, pull: scoped.pulls.get(number)! };
          else entry = undefined;
        }
        if (!entry) return toolError('Pull request not found');
        const result = store.mergePull(entry.repo, entry.pull, String(args.merge_method || 'squash'));
        if (!result) return toolError('Pull request has conflicts');
        return toolSuccess({
          sha: result.oid,
          merged: true,
          message: result.message,
          number: entry.pull.number,
        });
      }
      case 'create_label': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError('Repository not found');
        const label = store.addLabel(repo, String(args.name), String(args.color || 'ffffff'));
        return toolSuccess({ id: label.id, name: label.name, color: label.color });
      }
      case 'create_file': {
        const repo = store.getRepo(String(args.owner), String(args.repo));
        if (!repo) return toolError('Repository not found');
        const content = Buffer.from(String(args.content), 'utf8');
        const blob = store.addObject(repo, 'blob', content);
        const sha = store.commitChanges(
          repo,
          String(args.branch || repo.defaultBranch),
          [{ path: String(args.path), oid: blob }],
          String(args.message || `Add ${args.path}`),
        );
        return toolSuccess({ sha, path: String(args.path), content: { sha: blob } });
      }
      default:
        return toolError(`Unknown tool: ${String(rawName)}`);
    }
  } catch (error) {
    return toolError((error as Error).message);
  }
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
  };
}

function dispatch(store: ForgeStore, request: RpcRequest): string | null {
  if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const id = request.id;
  const isNotification = id === undefined || id === null;
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  switch (request.method) {
    case 'initialize': {
      const requested = String(params.protocolVersion || LATEST_VERSION);
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
      return rpcResult(id, JSON.stringify({
        protocolVersion: version,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
        instructions: 'Use server/discover to enumerate protocol revisions.',
      }));
    }
    case 'server/discover':
      return rpcResult(id, JSON.stringify({
        resultType: 'discovery',
        protocolVersion: LATEST_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      }));
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcResult(id, '{}');
    case 'tools/list':
      return rpcResult(id, TOOLS_RESULT_JSON);
    case 'resources/list':
      return rpcResult(id, '{"resources":[]}');
    case 'prompts/list':
      return rpcResult(id, '{"prompts":[]}');
    case 'tools/call': {
      const name = params.name;
      if (!findTool(name)) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      return rpcResult(id, callTool(store, name, params.arguments));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${request.method}`);
  }
}

export function handleMcp(store: ForgeStore, raw: string): McpResponse {
  const baseHeaders = {
    'content-type': 'application/json',
    'mcp-session-id': SESSION_ID,
    'MCP-Protocol-Version': LATEST_VERSION,
  };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return {
      status: 400,
      headers: baseHeaders,
      body: rpcError(null, -32700, 'Parse error'),
    };
  }
  if (Array.isArray(body)) {
    const answers = body
      .map((entry) => dispatch(store, entry as RpcRequest))
      .filter((entry): entry is string => entry !== null);
    if (!answers.length) return { status: 202, headers: baseHeaders, body: '' };
    return { status: 200, headers: baseHeaders, body: `[${answers.join(',')}]` };
  }
  const answer = dispatch(store, body as RpcRequest);
  if (answer === null) return { status: 202, headers: baseHeaders, body: '' };
  return { status: 200, headers: baseHeaders, body: answer };
}
