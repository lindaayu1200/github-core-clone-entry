// A small, dependency-free GraphQL executor for the forge schema.
import { ForgeStore, globalId, type Issue, type Pull, type Repo } from './store.ts';

type TokenKind = 'name' | 'string' | 'number' | 'punct' | 'var' | 'spread';
interface Token { kind: TokenKind; value: string }

type ValueNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface Directive { name: string; args: Map<string, ValueNode> }

interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Map<string, ValueNode>;
  directives: Directive[];
  selections: Selection[];
}
interface FragmentSelection { kind: 'fragment'; name: string; directives: Directive[] }
interface InlineSelection {
  kind: 'inline';
  typeCondition: string | null;
  directives: Directive[];
  selections: Selection[];
}
type Selection = FieldSelection | FragmentSelection | InlineSelection;

interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  selections: Selection[];
}

export interface GqlError { message: string; locations?: { line: number; column: number }[] }
export interface GqlResult { data: unknown; errors?: GqlError[] }

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c) || c === ',') { i++; continue; }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      i++;
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) name += source[i++];
      tokens.push({ kind: 'var', value: name });
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        i += 3;
        let value = '';
        while (i < source.length && !source.startsWith('"""', i)) {
          if (source[i] === '\\' && i + 1 < source.length) {
            value += source[i + 1];
            i += 2;
          } else value += source[i++];
        }
        i += 3;
        tokens.push({ kind: 'string', value });
        continue;
      }
      i++;
      let value = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          i += 2;
        } else value += source[i++];
      }
      i++;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(source[i + 1] || ''))) {
      let num = '';
      while (i < source.length && /[0-9.eE+\-]/.test(source[i])) num += source[i++];
      tokens.push({ kind: 'number', value: num });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let name = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) name += source[i++];
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    tokens.push({ kind: 'punct', value: c });
    i++;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  readonly fragments = new Map<string, Selection[]>();
  readonly operations: Operation[] = [];

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }
  private isPunct(value: string): boolean {
    return this.peek()?.kind === 'punct' && this.peek()?.value === value;
  }
  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) { this.pos++; return true; }
    return false;
  }
  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`Expected "${value}" near "${this.peek()?.value ?? 'end'}"`);
  }
  private expectName(): string {
    const token = this.next();
    if (!token || token.kind !== 'name') throw new Error('Expected a name');
    return token.value;
  }

  parse(): void {
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (!token) break;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (this.peek()?.value === 'on') this.next();
        if (this.peek()?.kind === 'name') this.next();
        this.parseDirectives();
        this.fragments.set(name, this.parseSelectionSet());
        continue;
      }
      this.operations.push(this.parseOperation());
    }
  }

  private parseOperation(): Operation {
    if (this.isPunct('{')) {
      return { kind: 'query', selections: this.parseSelectionSet() };
    }
    const word = this.expectName();
    if (word !== 'query' && word !== 'mutation' && word !== 'subscription') {
      throw new Error(`Unexpected token "${word}"`);
    }
    let name: string | undefined;
    if (this.peek()?.kind === 'name') name = this.expectName();
    if (this.eatPunct('(')) this.parseVariableDefinitions();
    this.parseDirectives();
    return { kind: word, name, selections: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): void {
    while (!this.eatPunct(')') && this.pos < this.tokens.length) {
      if (this.peek()?.kind === 'var') this.next();
      else this.next();
      if (this.eatPunct(':')) {
        let depth = 0;
        while (this.pos < this.tokens.length) {
          if (this.isPunct('[')) depth++;
          else if (this.isPunct(']')) depth--;
          else if (depth === 0 && (this.isPunct(',') || this.isPunct(')'))) break;
          this.next();
        }
      }
      if (this.eatPunct('=')) this.parseValue();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.eatPunct('}') && this.pos < this.tokens.length) {
      if (this.peek()?.kind === 'spread') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek()?.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        const directives = this.parseDirectives();
        if (!typeCondition && directives.length === 0 && this.peek()?.kind === 'name') {
          selections.push({ kind: 'fragment', name: this.expectName(), directives });
        } else {
          selections.push({ kind: 'inline', typeCondition, directives, selections: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let name = first;
      let alias = first;
      if (this.eatPunct(':')) {
        name = this.expectName();
      }
      const args = this.parseArguments();
      const directives = this.parseDirectives();
      const children = this.isPunct('{') ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, directives, selections: children });
    }
    return selections;
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    if (!this.eatPunct('(')) return args;
    while (!this.eatPunct(')') && this.pos < this.tokens.length) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseDirectives(): Directive[] {
    const directives: Directive[] = [];
    while (this.eatPunct('@')) {
      const name = this.expectName();
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (!token) throw new Error('Expected a value');
    if (token.kind === 'var') return { kind: 'variable', name: token.value };
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') return { kind: 'literal', value: Number(token.value) };
    if (token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.eatPunct(']') && this.pos < this.tokens.length) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.eatPunct('}') && this.pos < this.tokens.length) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.value === 'true') return { kind: 'literal', value: true };
    if (token.value === 'false') return { kind: 'literal', value: false };
    if (token.value === 'null') return { kind: 'literal', value: null };
    return { kind: 'literal', value: token.value };
  }
}

const SCHEMA: Record<string, Record<string, string>> = {
  Query: {
    repository: 'Repository', viewer: 'User', node: 'Node',
    __type: '__Type', __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    createRepository: 'CreateRepositoryPayload', mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String',
    description: 'String', owner: 'User', defaultBranchRef: 'Ref',
    viewerPermission: 'String', hasIssuesEnabled: 'Boolean', createdAt: 'String',
    issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection', url: 'String',
  },
  User: { id: 'ID', login: 'String', name: 'String' },
  Ref: { id: 'ID', name: 'String', target: 'GitObject' },
  GitObject: { id: 'ID', oid: 'String' },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String',
    createdAt: 'String', updatedAt: 'String', author: 'User', labels: 'LabelConnection',
    comments: 'IssueCommentConnection', url: 'String',
  },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String',
    headRefName: 'String', baseRefName: 'String', headRefOid: 'String', baseRefOid: 'String',
    mergeable: 'MergeableState', merged: 'Boolean', mergedAt: 'String', createdAt: 'String',
    author: 'User', files: 'PullRequestFileConnection', changedFiles: 'Int', url: 'String',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestConnection: {
    nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int',
  },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestFileConnection: {
    nodes: 'PullRequestFile', edges: 'PullRequestFileEdge', pageInfo: 'PageInfo', totalCount: 'Int',
  },
  PullRequestFileEdge: { node: 'PullRequestFile', cursor: 'String' },
  PullRequestFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge' },
  LabelEdge: { node: 'Label' },
  Label: { id: 'ID', name: 'String', color: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', totalCount: 'Int' },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'String', author: 'User' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String' },
  Node: { id: 'ID' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  CreateRepositoryPayload: { repository: 'Repository', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'AddCommentEdge', comment: 'IssueComment', clientMutationId: 'String' },
  AddCommentEdge: { node: 'IssueComment', cursor: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue', ofType: '__Type' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

interface Ctx {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, Selection[]>;
  errors: GqlError[];
}

function toJs(node: ValueNode | undefined, ctx: Ctx): unknown {
  if (!node) return undefined;
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'variable') return ctx.variables[node.name];
  if (node.kind === 'list') return node.values.map((v) => toJs(v, ctx));
  const result: Record<string, unknown> = {};
  for (const [key, value] of node.fields) result[key] = toJs(value, ctx);
  return result;
}

function arg(args: Map<string, ValueNode>, name: string, ctx: Ctx): unknown {
  return toJs(args.get(name), ctx);
}

function inputObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function findIssueById(
  store: ForgeStore,
  id: string,
): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.listRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return undefined;
}

function skipped(directives: Directive[], ctx: Ctx): boolean {
  for (const directive of directives) {
    const condition = arg(directive.args, 'if', ctx);
    if (directive.name === 'skip' && condition === true) return true;
    if (directive.name === 'include' && condition === false) return true;
  }
  return false;
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    createdAt: ctxTimestamp(issue.seq),
    updatedAt: ctxTimestamp(issue.seq),
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'MERGED' ? 'MERGED' : pull.state,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: ctx.storeResolve(repo, pull.head),
    baseRefOid: ctx.storeResolve(repo, pull.base),
    mergeable: !ctx.storeResolve(repo, pull.head) || !ctx.storeResolve(repo, pull.base)
      ? 'UNKNOWN'
      : ctx.storeMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    merged: pull.merged,
    mergedAt: pull.merged ? ctxTimestamp(pull.seq + 1) : null,
    createdAt: ctxTimestamp(pull.seq),
    changedFiles: pull.files.length,
    url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// Injected by executeQuery to avoid passing the store through every object builder.
const ctx: {
  storeResolve: (repo: Repo, ref: string) => string | null;
  storeMergeable: (repo: Repo, pull: Pull) => boolean;
  timestamp: (seq: number) => string;
} = {
  storeResolve: () => null,
  storeMergeable: () => false,
  timestamp: () => '',
};

function ctxTimestamp(seq: number): string {
  return ctx.timestamp(seq);
}

function repoObject(store: ForgeStore, repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    owner: { __typename: 'User', id: globalId('User', repo.owner, 0), login: repo.owner, name: repo.owner },
    defaultBranchRef: {
      __typename: 'Ref',
      id: globalId('Ref', repo.id, 0),
      name: repo.defaultBranch,
      target: {
        __typename: 'GitObject',
        id: store.resolve(repo, `refs/heads/${repo.defaultBranch}`) || '',
        oid: store.resolve(repo, `refs/heads/${repo.defaultBranch}`) || '',
      },
    },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: ctxTimestamp(repo.seq),
    url: `/${repo.owner}/${repo.name}`,
  };
}

function introspectType(name: string): Record<string, unknown> {
  const fields = SCHEMA[name]
    ? Object.keys(SCHEMA[name]).map((field) => ({ __typename: '__Field', name: field, description: '' }))
    : [];
  const enumValues = ENUMS[name]
    ? ENUMS[name].map((value) => ({ __typename: '__EnumValue', name: value, description: '' }))
    : [];
  return {
    __typename: '__Type',
    name,
    kind: ENUMS[name] ? 'ENUM' : 'OBJECT',
    description: `The ${name} type`,
    fields,
    enumValues,
    ofType: null,
  };
}

function connection<T>(nodes: T[], first: unknown, after?: unknown): Record<string, unknown> {
  const total = nodes.length;
  const limit = typeof first === 'number' && first >= 0 ? first : total;
  let start = 0;
  if (typeof after === 'string') {
    const match = /^cursor:(\d+)$/.exec(after);
    if (match) start = Math.min(total, Number(match[1]));
  }
  const slice = nodes.slice(start, start + limit);
  return {
    __typename: 'Connection',
    nodes: slice,
    edges: slice.map((node, index) => ({
      __typename: 'Edge',
      node,
      cursor: `cursor:${start + index + 1}`,
    })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < total,
      hasPreviousPage: start > 0,
      endCursor: `cursor:${start + slice.length}`,
    },
    totalCount: total,
  };
}

function resolveField(
  parent: Record<string, unknown> | null,
  field: FieldSelection,
  typeName: string,
  ctxState: Ctx,
): unknown {
  const store = ctxState.store;
  const name = field.name;
  if (name === '__typename') return parent?.__typename || typeName;
  if (typeName === 'Query') {
    if (name === '__type') return introspectType(String(arg(field.args, 'name', ctxState) || ''));
    if (name === '__schema') {
      return {
        __typename: '__Schema',
        queryType: introspectType('Query'),
        mutationType: introspectType('Mutation'),
        types: [...Object.keys(SCHEMA), ...Object.keys(ENUMS)].map(introspectType),
      };
    }
    if (name === 'viewer') {
      return {
        __typename: 'User',
        id: globalId('User', store.login, 0),
        login: store.login,
        name: store.login,
      };
    }
    if (name === 'repository') {
      const repo = store.getRepo(String(arg(field.args, 'owner', ctxState) || ''), String(arg(field.args, 'name', ctxState) || ''));
      return repo ? repoObject(store, repo) : null;
    }
    if (name === 'node') {
      const id = String(arg(field.args, 'id', ctxState) || '');
      for (const repo of store.listRepos()) {
        if (repo.id === id) return repoObject(store, repo);
        for (const issue of repo.issues.values()) if (issue.id === id) return issueObject(repo, issue);
        for (const pull of repo.pulls.values()) if (pull.id === id) return pullObject(repo, pull);
      }
      return null;
    }
  }
  if (typeName === 'Mutation') {
    const input = inputObject(arg(field.args, 'input', ctxState));
    const pick = (key: string, fallback?: unknown): unknown =>
      input[key] !== undefined ? input[key] : arg(field.args, key, ctxState) ?? fallback;
    if (name === 'createIssue') {
      const repo = store.getRepoById(String(pick('repositoryId') || ''));
      if (!repo) {
        ctxState.errors.push({ message: 'Repository not found' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const labels = (Array.isArray(pick('labels', [])) ? pick('labels', []) : []) as string[];
      try {
        const issue = store.createIssue(repo, String(pick('title') || ''), String(pick('body', '') || ''), labels);
        return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: pick('clientMutationId', null) };
      } catch (error) {
        ctxState.errors.push({ message: (error as Error).message });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
    }
    if (name === 'closeIssue') {
      const found = findIssueById(store, String(pick('issueId') || ''));
      if (!found) {
        ctxState.errors.push({ message: 'Issue not found' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      found.issue.state = 'CLOSED';
      return {
        __typename: 'CloseIssuePayload',
        issue: issueObject(found.repo, found.issue),
        clientMutationId: pick('clientMutationId', null),
      };
    }
    if (name === 'addComment') {
      const found = findIssueById(store, String(pick('subjectId') || ''));
      if (!found) {
        ctxState.errors.push({ message: 'Issue not found' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const comment = store.addComment(found.repo, found.issue, String(pick('body', '') || ''));
      const node = {
        __typename: 'IssueComment',
        id: comment.gid,
        body: comment.body,
        createdAt: ctxTimestamp(comment.seq),
        author: { __typename: 'User', login: store.login },
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'AddCommentEdge', node, cursor: `cursor:${comment.id}` },
        clientMutationId: pick('clientMutationId', null),
      };
    }
    if (name === 'createPullRequest') {
      const repo = store.getRepoById(String(pick('repositoryId') || ''));
      if (!repo) {
        ctxState.errors.push({ message: 'Repository not found' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const head = String(pick('head', pick('headRefName', '')) || '');
      const base = String(pick('base', pick('baseRefName', repo.defaultBranch)) || repo.defaultBranch);
      if (!store.resolve(repo, head)) {
        ctxState.errors.push({ message: `Head branch ${head} not found` });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const pull = store.createPull(repo, String(pick('title', head) || head), head, base, String(pick('body', '') || ''));
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
    }
    if (name === 'createRepository') {
      const repo = store.createRepo(store.login, String(pick('name') || ''), String(pick('description', '') || ''));
      return { __typename: 'CreateRepositoryPayload', repository: repoObject(store, repo) };
    }
    if (name === 'mergePullRequest') {
      const id = String(pick('pullRequestId') || '');
      let found: { repo: Repo; pull: Pull } | undefined;
      for (const [num, entry] of store.pullsByNumber) {
        if (entry.pull.id === id || String(num) === id) { found = entry; break; }
      }
      if (!found) {
        ctxState.errors.push({ message: 'Pull request not found' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const result = store.mergePull(found.repo, found.pull, String(pick('mergeMethod', 'squash')));
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: result ? pullObject(found.repo, found.pull) : null,
      };
    }
  }
  if (!parent) return null;

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'issue' || name === 'pullRequest') {
      const number = Number(arg(field.args, 'number', ctxState));
      const value = name === 'issue' ? repo.issues.get(number) : repo.pulls.get(number);
      if (!value) return null;
      return name === 'issue' ? issueObject(repo, value as Issue) : pullObject(repo, value as Pull);
    }
    if (name === 'issues' || name === 'pullRequests') {
      const states = arg(field.args, 'states', ctxState);
      const orderBy = inputObject(arg(field.args, 'orderBy', ctxState));
      const direction = String(orderBy.direction || 'DESC');
      const values: (Issue | Pull)[] = name === 'issues'
        ? [...repo.issues.values()]
        : [...repo.pulls.values()];
      let filtered = values;
      if (Array.isArray(states) && states.length) {
        filtered = filtered.filter((value) => states.includes(value.state));
      }
      filtered.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const nodes = filtered.map((value) =>
        name === 'issues' ? issueObject(repo, value as Issue) : pullObject(repo, value as Pull),
      );
      return connection(
        nodes,
        arg(field.args, 'first', ctxState),
        arg(field.args, 'after', ctxState),
      );
    }
  }
  if (typeName === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (name === 'files') {
      const nodes = pull.files.map((file) => ({
        __typename: 'PullRequestFile',
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
      }));
      return connection(nodes, arg(field.args, 'first', ctxState));
    }
  }
  if (typeName === 'Issue') {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (name === 'labels') {
      return {
        __typename: 'LabelConnection',
        nodes: issue.labels.map((labelName) => {
          const label = store.label(repo, labelName);
          return { __typename: 'Label', name: labelName, color: label?.color || 'ffffff', id: label?.id || '' };
        }),
        edges: issue.labels.map((labelName) => ({ __typename: 'LabelEdge', node: { __typename: 'Label', name: labelName } })),
      };
    }
    if (name === 'comments') {
      const nodes = issue.comments.map((comment) => ({
        __typename: 'IssueComment',
        id: comment.gid,
        body: comment.body,
        createdAt: ctxTimestamp(comment.seq),
        author: { __typename: 'User', login: store.login },
      }));
      return { __typename: 'IssueCommentConnection', nodes, totalCount: nodes.length };
    }
    if (name === 'author') return { __typename: 'User', login: store.login, id: globalId('User', store.login, 0) };
  }
  if (typeName === 'PullRequest' && name === 'author') {
    return { __typename: 'User', login: store.login, id: globalId('User', store.login, 0) };
  }
  if (typeName === '__Type') {
    if (name === 'fields' || name === 'enumValues') {
      const value = parent[name];
      return Array.isArray(value) ? value : [];
    }
  }
  return parent[name];
}

function selectFields(
  parent: Record<string, unknown> | null,
  selections: Selection[],
  typeName: string,
  ctxState: Ctx,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const expand = (list: Selection[], currentType: string = typeName): void => {
    for (const selection of list) {
      if (skipped(selection.directives, ctxState)) continue;
      if (selection.kind === 'fragment') {
        const fragment = ctxState.fragments.get(selection.name);
        if (fragment) expand(fragment, currentType);
        continue;
      }
      if (selection.kind === 'inline') {
        expand(selection.selections, selection.typeCondition || currentType);
        continue;
      }
      const allowed = SCHEMA[currentType] || {};
      if (!(selection.name in allowed) && currentType !== '__Type' && currentType !== '__Schema') {
        ctxState.errors.push({
          message: `Cannot query field "${selection.name}" on type "${currentType}".`,
        });
        result[selection.alias] = null;
        continue;
      }
      let value: unknown;
      try {
        value = resolveField(parent, selection, currentType, ctxState);
      } catch (error) {
        ctxState.errors.push({ message: (error as Error).message });
        result[selection.alias] = null;
        continue;
      }
      if (value !== null && value !== undefined && selection.selections.length) {
        const childType = SCHEMA[currentType]?.[selection.name] || currentType;
        if (Array.isArray(value)) {
          value = value.map((item) =>
            item && typeof item === 'object'
              ? selectFields(item as Record<string, unknown>, selection.selections, childType, ctxState)
              : null,
          );
        } else if (typeof value === 'object') {
          value = selectFields(value as Record<string, unknown>, selection.selections, childType, ctxState);
        }
      }
      if (value === undefined) value = null;
      result[selection.alias] = value;
    }
  };
  expand(selections);
  return result;
}

export function runGraphql(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown> = {},
  operationName?: string,
): GqlResult | GqlResult[] {
  const parser = new Parser(query);
  parser.parse();
  ctx.storeResolve = (repo, ref) => store.resolve(repo, ref) || null;
  ctx.storeMergeable = (repo, pull) => store.mergeable(repo, pull);
  ctx.timestamp = (seq) => new Date(1700000000000 + seq * 1000).toISOString();

  const execute = (operation: Operation): GqlResult => {
    const errors: GqlError[] = [];
    const ctxState: Ctx = { store, variables, fragments: parser.fragments, errors };
    const typename = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    try {
      const data = selectFields(null, operation.selections, typename, ctxState);
      return errors.length ? { data, errors } : { data };
    } catch (error) {
      return { data: null, errors: [{ message: (error as Error).message }] };
    }
  };

  const operations = operationName
    ? parser.operations.filter((op) => op.name === operationName)
    : parser.operations;
  if (!operations.length) return { data: null, errors: [{ message: 'Operation not found' }] };
  if (parser.operations.length === 1) return execute(parser.operations[0]);
  if (operationName || operations.length === 1) return execute(operations[0]);
  return operations.map(execute);
}
