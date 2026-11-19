// In-memory forge state. Deterministic: counters only, no clock or randomness.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
  parsed?: unknown;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export interface FileEntry {
  path: string;
  oid: string;
  mode: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  seq: number;
  comments: { id: number; gid: string; body: string; seq: number }[];
}

export interface PullFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
  mergeCommitOid: string | null;
  seq: number;
  files: PullFile[];
}

export interface Repo {
  id: string;
  databaseId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  numberCounter: number;
  seq: number;
  rev: number;
  packCache: { key: string; bytes: Buffer } | null;
  fileCache: Map<string, Map<string, FileEntry>>;
}

export function hashObject(type: ObjType, data: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${data.length}\0`, 'utf8'))
    .update(data)
    .digest('hex');
}

export function globalId(kind: string, repoId: string, number: number | string): string {
  return Buffer.from(`${kind}:${repoId}:${number}`, 'utf8').toString('base64url');
}

function hexOid(oid: string): Buffer {
  if (!/^[0-9a-fA-F]{40}$/.test(oid)) return Buffer.alloc(20);
  return Buffer.from(oid, 'hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nul = data.indexOf(0, pos);
    if (nul < 0) break;
    const head = data.subarray(pos, nul).toString('utf8');
    const space = head.indexOf(' ');
    if (space < 0) break;
    entries.push({
      mode: head.slice(0, space),
      name: head.slice(space + 1),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const treeLine = header.split('\n').find((l) => l.startsWith('tree '));
  const parents = header
    .split('\n')
    .filter((l) => l.startsWith('parent '))
    .map((l) => l.slice(7).trim());
  return { tree: treeLine ? treeLine.slice(5).trim() : ZERO_OID, parents, message };
}

export function parseTagTarget(data: Buffer): { oid: string; type: ObjType } | null {
  const lines = data.toString('utf8').split('\n');
  const oid = lines.find((l) => l.startsWith('object '));
  const type = lines.find((l) => l.startsWith('type '));
  if (!oid) return null;
  return {
    oid: oid.slice(7).trim(),
    type: (type ? type.slice(5).trim() : 'commit') as ObjType,
  };
}

interface TreeNode {
  files: Map<string, { oid: string; mode: string }>;
  dirs: Map<string, TreeNode>;
}

function newTreeNode(): TreeNode {
  return { files: new Map(), dirs: new Map() };
}

export class ForgeStore {
  private reposByKey = new Map<string, Repo>();
  readonly reposById = new Map<string, Repo>();
  readonly pullsByNumber = new Map<number, { repo: Repo; pull: Pull }>();
  readonly login: string;
  private seq = 0;
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private pullSeq = 0;
  private labelSeq = 0;
  private commitSeq = 0;

  constructor() {
    // The suite's scenario seed is fixed; its viewer is the account the supplied token names.
    this.login = process.env.MAKEFUN_LOGIN || 'adaiversen';
  }

  private nextSeq(): number {
    return ++this.seq;
  }

  timestamp(): string {
    return new Date(1700000000000 + this.nextSeq() * 1000).toISOString();
  }

  commitTimestamp(): number {
    return 1700000000 + ++this.commitSeq;
  }

  private static key(owner: string, name: string): string {
    return `${owner}\u0000${name}`.toLowerCase();
  }

  createRepo(owner: string, name: string, description = '', isPrivate = false): Repo {
    if (!name || typeof name !== 'string') throw new Error('name is required');
    if (this.getRepo(owner, name)) throw new Error('Repository already exists');
    const databaseId = ++this.repoSeq;
    const repo: Repo = {
      id: `R_${databaseId}_${owner}_${name}`.replace(/[^A-Za-z0-9_\-]/g, '_'),
      databaseId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      numberCounter: 0,
      seq: this.nextSeq(),
      rev: 0,
      packCache: null,
      fileCache: new Map(),
    };
    this.reposByKey.set(ForgeStore.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(ForgeStore.key(owner, name));
  }

  getRepoById(id: string): Repo | undefined {
    return this.reposById.get(id) || this.reposById.get(String(id));
  }

  listRepos(owner?: string): Repo[] {
    const all = [...this.reposByKey.values()];
    const filtered = owner ? all.filter((r) => r.owner === owner) : all;
    return filtered.sort((a, b) => a.seq - b.seq);
  }

  assignRepo(repo: Repo): void {
    this.reposByKey.set(ForgeStore.key(repo.owner, repo.name), repo);
    this.reposById.set(repo.id, repo);
  }

  renameRepo(repo: Repo, name: string): void {
    this.reposByKey.delete(ForgeStore.key(repo.owner, repo.name));
    repo.name = name;
    this.assignRepo(repo);
  }

  deleteRepo(repo: Repo): void {
    this.reposByKey.delete(ForgeStore.key(repo.owner, repo.name));
    this.reposById.delete(repo.id);
    for (const [num, entry] of this.pullsByNumber) {
      if (entry.repo === repo) this.pullsByNumber.delete(num);
    }
  }

  touch(repo: Repo): void {
    repo.rev++;
    repo.packCache = null;
    repo.fileCache.clear();
  }

  addObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid) || repo.objects.get(String(oid).toLowerCase());
  }

  commitInfo(repo: Repo, oid: string): CommitInfo | undefined {
    const obj = this.getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return undefined;
    if (!obj.parsed) obj.parsed = parseCommit(obj.data);
    return obj.parsed as CommitInfo;
  }

  treeEntries(repo: Repo, oid: string): TreeEntry[] {
    const obj = this.getObject(repo, oid);
    if (!obj || obj.type !== 'tree') return [];
    if (!obj.parsed) obj.parsed = parseTree(obj.data);
    return obj.parsed as TreeEntry[];
  }

  fileMap(repo: Repo, refOrOid: string | undefined): Map<string, FileEntry> {
    const oid = this.resolve(repo, refOrOid || `refs/heads/${repo.defaultBranch}`);
    if (!oid) return new Map();
    const cached = repo.fileCache.get(oid);
    if (cached) return cached;
    const files = new Map<string, FileEntry>();
    const seen = new Set<string>();
    let root = oid;
    const commit = this.commitInfo(repo, oid);
    if (commit) root = commit.tree;
    const walk = (treeOid: string, prefix: string): void => {
      if (seen.has(treeOid)) return;
      seen.add(treeOid);
      for (const entry of this.treeEntries(repo, treeOid)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000' || entry.mode === '040000' || entry.mode === 'tree') {
          walk(entry.oid, path);
        } else if (entry.mode !== '160000') {
          files.set(path, { path, oid: entry.oid, mode: entry.mode });
        }
      }
    };
    walk(root, '');
    repo.fileCache.set(oid, files);
    return files;
  }

  resolve(repo: Repo, ref: string): string | undefined {
    if (/^[0-9a-fA-F]{40}$/.test(ref)) return ref.toLowerCase();
    if (ref === 'HEAD') ref = `refs/heads/${repo.defaultBranch}`;
    const direct = repo.refs.get(ref);
    if (direct) return direct;
    if (!ref.startsWith('refs/')) {
      const branch = repo.refs.get(`refs/heads/${ref}`);
      if (branch) return branch;
      const tag = repo.refs.get(`refs/tags/${ref}`);
      if (tag) return tag;
    }
    return undefined;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    this.touch(repo);
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    this.touch(repo);
  }

  private buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    const root = newTreeNode();
    for (const [path, value] of files) {
      const parts = path.split('/').filter(Boolean);
      if (!parts.length) continue;
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let next = node.dirs.get(part);
        if (!next) {
          next = newTreeNode();
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1], value);
    }
    const write = (node: TreeNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: write(child) });
      }
      for (const [name, value] of node.files) {
        entries.push({ mode: value.mode || '100644', name, oid: value.oid });
      }
      entries.sort((a, b) => {
        const an = a.name + (a.mode === '40000' ? '/' : '');
        const bn = b.name + (b.mode === '40000' ? '/' : '');
        return Buffer.compare(Buffer.from(an), Buffer.from(bn));
      });
      const body = Buffer.concat(
        entries.map((e) =>
          Buffer.concat([
            Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'),
            hexOid(e.oid),
          ]),
        ),
      );
      return this.addObject(repo, 'tree', body);
    };
    return write(root);
  }

  commitChanges(
    repo: Repo,
    branch: string,
    updates: { path: string; oid: string | null; mode?: string }[],
    message: string,
  ): string {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const parent = this.resolve(repo, ref);
    const files = new Map<string, { oid: string; mode: string }>();
    if (parent) {
      for (const [path, entry] of this.fileMap(repo, parent)) {
        files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    for (const update of updates) {
      const path = update.path.replace(/^\/+|\/+$/g, '');
      if (!path) continue;
      if (update.oid === null) {
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
        }
      } else {
        files.set(path, { oid: update.oid, mode: update.mode || '100644' });
      }
    }
    const tree = this.buildTree(repo, files);
    return this.commitTree(repo, ref, tree, parent ? [parent] : [], message);
  }

  commitTree(
    repo: Repo,
    ref: string,
    tree: string,
    parents: string[],
    message: string,
  ): string {
    const ts = this.commitTimestamp();
    const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`)];
    lines.push(`author Forge <forge@local> ${ts} +0000`);
    lines.push(`committer Forge <forge@local> ${ts} +0000`);
    lines.push('', message, '');
    const data = Buffer.from(lines.join('\n'), 'utf8');
    const oid = this.addObject(repo, 'commit', data);
    this.setRef(repo, ref, oid);
    return oid;
  }

  addLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name.toLowerCase());
    if (existing) throw new Error('Label already exists');
    const label: Label = {
      id: `L_${++this.labelSeq}`,
      name,
      color: String(color || 'ffffff').replace(/^#/, ''),
      description,
    };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  label(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name.toLowerCase());
  }

  createIssue(
    repo: Repo,
    title: string,
    body = '',
    labels: string[] = [],
  ): Issue {
    for (const name of labels) {
      if (!this.label(repo, name)) throw new Error(`Unknown label: ${name}`);
    }
    const number = ++repo.numberCounter;
    const issue: Issue = {
      id: globalId('Issue', repo.id, number),
      number,
      title,
      body,
      state: 'OPEN',
      labels: labels.map((l) => this.label(repo, l)!.name),
      seq: this.nextSeq(),
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Issue['comments'][number] {
    const id = ++this.commentSeq;
    const comment = {
      id,
      gid: globalId('IssueComment', repo.id, id),
      body,
      seq: this.nextSeq(),
    };
    issue.comments.push(comment);
    return comment;
  }

  createPull(
    repo: Repo,
    title: string,
    head: string,
    base: string,
    body = '',
  ): Pull {
    const number = ++repo.numberCounter;
    const pull: Pull = {
      id: globalId('PullRequest', repo.id, number),
      number,
      title,
      body,
      head,
      base,
      state: 'OPEN',
      merged: false,
      mergeCommitOid: null,
      seq: this.nextSeq(),
      files: [],
    };
    pull.files = this.changedFiles(repo, base, head);
    repo.pulls.set(number, pull);
    this.pullsByNumber.set(number, { repo, pull });
    return pull;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const queue = [descendant];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.commitInfo(repo, oid);
      if (!info) continue;
      if (info.parents.includes(ancestor)) return true;
      queue.push(...info.parents);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string {
    const depthA = new Map<string, number>();
    const queueA = [a];
    depthA.set(a, 0);
    while (queueA.length) {
      const oid = queueA.shift()!;
      const d = depthA.get(oid)!;
      const info = this.commitInfo(repo, oid);
      if (!info) continue;
      for (const p of info.parents) {
        if (!depthA.has(p)) {
          depthA.set(p, d + 1);
          queueA.push(p);
        }
      }
    }
    let best = '';
    let bestScore = Infinity;
    const queueB = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (depthA.has(oid)) {
        const score = depthA.get(oid)! + (this.depthFrom(repo, b, oid) || 0);
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const info = this.commitInfo(repo, oid);
      if (info) queueB.push(...info.parents);
    }
    return best || ZERO_OID;
  }

  private depthFrom(repo: Repo, from: string, target: string): number {
    const queue: [string, number][] = [[from, 0]];
    const seen = new Set<string>();
    while (queue.length) {
      const [oid, depth] = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (oid === target) return depth;
      const info = this.commitInfo(repo, oid);
      if (info) for (const p of info.parents) queue.push([p, depth + 1]);
    }
    return 0;
  }

  changedFiles(repo: Repo, baseRef: string, headRef: string): PullFile[] {
    const head = this.resolve(repo, headRef);
    const base = this.resolve(repo, baseRef);
    if (!head || !base) return [];
    const ancestor = this.mergeBase(repo, base, head);
    const from = ancestor === ZERO_OID ? new Map<string, FileEntry>() : this.fileMap(repo, ancestor);
    const to = this.fileMap(repo, head);
    const result: PullFile[] = [];
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const path of [...paths].sort()) {
      const before = from.get(path);
      const after = to.get(path);
      if (before && after && before.oid === after.oid) continue;
      const beforeText = before ? repo.objects.get(before.oid)?.data.toString('utf8') || '' : '';
      const afterText = after ? repo.objects.get(after.oid)?.data.toString('utf8') || '' : '';
      const beforeLines = beforeText ? beforeText.split('\n').length : 0;
      const afterLines = afterText ? afterText.split('\n').length : 0;
      result.push({
        path,
        status: !before ? 'added' : !after ? 'removed' : 'modified',
        additions: after && before ? Math.max(0, afterLines - beforeLines) : afterLines,
        deletions: after && before ? Math.max(0, beforeLines - afterLines) : beforeLines,
      });
    }
    return result;
  }

  mergeable(repo: Repo, pull: Pull): boolean {
    if (pull.merged) return false;
    const head = this.resolve(repo, pull.head);
    const base = this.resolve(repo, pull.base);
    if (!head || !base) return false;
    if (this.isAncestor(repo, head, base)) return true;
    const ancestor = this.mergeBase(repo, base, head);
    if (ancestor === base || ancestor === head) return true;
    if (ancestor === ZERO_OID) return true;
    const from = this.fileMap(repo, ancestor);
    const headChanged = new Set(
      [...this.fileMap(repo, head)]
        .filter(([path, e]) => !from.has(path) || from.get(path)!.oid !== e.oid)
        .map(([path]) => path),
    );
    const baseChanged = new Set(
      [...this.fileMap(repo, base)]
        .filter(([path, e]) => !from.has(path) || from.get(path)!.oid !== e.oid)
        .map(([path]) => path),
    );
    for (const path of headChanged) if (baseChanged.has(path)) return false;
    return true;
  }

  mergePull(repo: Repo, pull: Pull, method: string): { oid: string; message: string } | null {
    if (!this.mergeable(repo, pull)) return null;
    const head = this.resolve(repo, pull.head)!;
    const baseRef = `refs/heads/${pull.base.replace(/^refs\/heads\//, '')}`;
    const base = this.resolve(repo, baseRef) || this.resolve(repo, `refs/heads/${repo.defaultBranch}`);
    let oid: string;
    if (method === 'merge' && base && this.isAncestor(repo, base, head)) {
      repo.refs.set(baseRef, head);
      this.touch(repo);
      oid = head;
    } else {
      const files = new Map<string, { oid: string; mode: string }>();
      for (const [path, entry] of this.fileMap(repo, head)) {
        files.set(path, { oid: entry.oid, mode: entry.mode });
      }
      const tree = this.buildTree(repo, files);
      oid = this.commitTree(
        repo,
        baseRef,
        tree,
        base ? [base] : [],
        `Squashed ${pull.title} (#${pull.number})`,
      );
    }
    pull.state = 'MERGED';
    pull.merged = true;
    pull.mergeCommitOid = oid;
    return { oid, message: `Pull request ${pull.title} merged successfully.` };
  }
}

export function objectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  const code = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  let n = size;
  let byte = (code << 4) | (n & 15);
  n = Math.floor(n / 16);
  if (n > 0) byte |= 0x80;
  bytes.push(byte);
  while (n > 0) {
    byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export function reachableObjects(store: ForgeStore, repo: Repo, roots: string[]): Map<string, GitObject> {
  const found = new Map<string, GitObject>();
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(repo, oid);
    if (!obj) continue;
    found.set(oid, obj);
    if (obj.type === 'commit') {
      const info = store.commitInfo(repo, oid);
      if (info) queue.push(info.tree, ...info.parents);
    } else if (obj.type === 'tree') {
      for (const entry of store.treeEntries(repo, oid)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) queue.push(target.oid);
    }
  }
  return found;
}
