// Git smart HTTP: protocol v2 / v0 upload-pack, v0 receive-pack, packfile IO.
import { createHash } from 'node:crypto';
import { deflateSync, createInflate } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForgeStore,
  ZERO_OID,
  reachableObjects,
  objectHeader,
  parseTagTarget,
  type GitObject,
  type ObjType,
  type Repo,
} from './store.ts';

const FLUSH = Buffer.from('0000');

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

function readAll(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readPkt(buf: Buffer, pos: number): { payload: Buffer; length: number } | null {
  if (pos + 4 > buf.length) return null;
  const length = parseInt(buf.subarray(pos, pos + 4).toString('latin1'), 16);
  if (!Number.isFinite(length) || length < 4 || pos + length > buf.length) return null;
  return { payload: buf.subarray(pos + 4, pos + length), length };
}

interface Inflated {
  out: Buffer;
  consumed: number;
}

/** Inflate exactly one zlib stream and report how many input bytes it used. */
function inflateOne(data: Buffer): Promise<Inflated> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () =>
      resolve({ out: Buffer.concat(chunks), consumed: stream.bytesWritten }),
    );
    stream.on('error', reject);
    stream.end(data);
  });
}

function varint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const byte = buf[p++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, next: p };
    shift += 7;
  }
  return { value, next: p };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const baseSize = varint(delta, 0);
  const resultSize = varint(delta, baseSize.next);
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let pos = resultSize.next;
  while (pos < delta.length) {
    const cmd = delta[pos++];
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) offset |= delta[pos++];
      if (cmd & 0x02) offset |= delta[pos++] << 8;
      if (cmd & 0x04) offset |= delta[pos++] << 16;
      if (cmd & 0x08) offset |= delta[pos++] << 24;
      if (cmd & 0x10) size |= delta[pos++];
      if (cmd & 0x20) size |= delta[pos++] << 8;
      if (cmd & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (cmd !== 0) {
      out.push(delta.subarray(pos, pos + cmd));
      pos += cmd;
    } else {
      throw new Error('invalid delta command');
    }
  }
  return Buffer.concat(out);
}

interface PendingDelta {
  baseOid: string;
  data: Buffer;
}

/** Parse a v2 packfile into the repository's object database. */
export async function parsePack(store: ForgeStore, repo: Repo, pack: Buffer): Promise<number> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('latin1') !== 'PACK') {
    throw new Error('invalid packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const offsetToOid = new Map<number, string>();
  const pending: PendingDelta[] = [];
  let parsed = 0;

  for (let i = 0; i < count; i++) {
    const start = pos;
    let byte = pack[pos++];
    if (byte === undefined) throw new Error('truncated packfile');
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      byte = pack[pos++];
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        distance = ((distance + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - distance;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = await inflateOne(pack.subarray(pos));
    pos += inflated.consumed;
    const data = inflated.out;

    if (typeCode >= 1 && typeCode <= 4) {
      const type: ObjType = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : 'tag';
      const oid = store.addObject(repo, type, data);
      offsetToOid.set(start, oid);
      parsed++;
      continue;
    }
    if (typeCode === 6) {
      const parentOid = offsetToOid.get(baseOffset!);
      if (!parentOid) throw new Error('ofs-delta base not found');
      const parent = store.getObject(repo, parentOid);
      if (!parent) throw new Error('ofs-delta object missing');
      const resolved = applyDelta(parent.data, data);
      const oid = store.addObject(repo, parent.type, resolved);
      offsetToOid.set(start, oid);
      parsed++;
      continue;
    }
    if (typeCode === 7) {
      pending.push({ baseOid: baseOid!, data });
      offsetToOid.set(start, '');
      continue;
    }
    throw new Error('unknown pack object type');
  }

  // ref-deltas may refer to objects that appear later in the pack.
  let remaining = pending.slice();
  while (remaining.length) {
    const next: PendingDelta[] = [];
    let progressed = false;
    for (const delta of remaining) {
      const parent = store.getObject(repo, delta.baseOid);
      if (!parent) {
        next.push(delta);
        continue;
      }
      const resolved = applyDelta(parent.data, delta.data);
      store.addObject(repo, parent.type, resolved);
      parsed++;
      progressed = true;
    }
    if (!progressed) throw new Error('unresolved ref-delta base');
    remaining = next;
  }
  store.touch(repo);
  return parsed;
}

interface FetchShape {
  depth?: number;
  shallow: string[];
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

function fetchShape(lines: string[]): FetchShape {
  let depth: number | undefined;
  const shallow: string[] = [];
  for (const line of lines) {
    if (line.startsWith('deepen ')) {
      const parsed = Number(line.slice(7).trim());
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim().toLowerCase();
      if (oid) shallow.push(oid);
    }
  }
  return { depth, shallow };
}

/**
 * Select the objects a fetch should send. Haves are excluded as usual, except
 * for shallow boundaries the client explicitly says it already has: those are
 * starting points for deepening, not objects to prune from the answer.
 */
function collectFetchObjects(
  store: ForgeStore,
  repo: Repo,
  roots: string[],
  haves: string[],
  shape: FetchShape,
): FetchPlan {
  const boundaries = new Set(shape.shallow);
  const excluded = new Set<string>();
  for (const have of haves) {
    if (boundaries.has(have.toLowerCase())) continue;
    for (const oid of reachableObjects(store, repo, [have]).keys()) excluded.add(oid);
  }

  const objects = new Map<string, GitObject>();
  const seen = new Set<string>();
  const queue: { oid: string; distance: number }[] = roots.map((oid) => ({ oid, distance: 0 }));
  const shallow = new Set<string>();

  while (queue.length) {
    const { oid, distance } = queue.shift()!;
    if (seen.has(oid) || excluded.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(repo, oid);
    if (!obj) continue;
    objects.set(oid, obj);

    if (obj.type === 'commit') {
      const info = store.commitInfo(repo, oid);
      if (!info) continue;
      queue.push({ oid: info.tree, distance });
      if (shape.depth === undefined) {
        for (const parent of info.parents) queue.push({ oid: parent, distance: distance + 1 });
      } else {
        let cut = false;
        for (const parent of info.parents) {
          if (distance + 1 < shape.depth) queue.push({ oid: parent, distance: distance + 1 });
          else cut = true;
        }
        if (cut && info.parents.length) shallow.add(oid);
      }
    } else if (obj.type === 'tree') {
      for (const entry of store.treeEntries(repo, oid)) {
        queue.push({ oid: entry.oid, distance });
      }
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target) queue.push({ oid: target.oid, distance });
    }
  }

  const unshallow = [...boundaries].filter((oid) => !shallow.has(oid));
  return { objects, shallow: [...shallow], unshallow };
}

/** Build a deterministic packfile from an explicit object set. */
function packObjects(repo: Repo, objects: Map<string, GitObject>): Buffer {
  const entries = [...objects.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const key = entries.map(([oid]) => oid).join(',');
  if (repo.packCache && repo.packCache.key === key) return repo.packCache.bytes;

  const chunks: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  chunks[1].writeUInt32BE(2, 0);
  chunks[2].writeUInt32BE(entries.length, 0);
  for (const [, obj] of entries) {
    chunks.push(objectHeader(obj.type, obj.data.length));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const bytes = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  repo.packCache = { key, bytes };
  return bytes;
}

/** Build a deterministic packfile for the given roots, excluding objects reachable from haves. */
export function buildPack(
  store: ForgeStore,
  repo: Repo,
  roots: string[],
  haves: string[] = [],
): Buffer {
  const plan = collectFetchObjects(store, repo, roots, haves, { depth: undefined, shallow: [] });
  return packObjects(repo, plan.objects);
}

function refsForAdvertisement(store: ForgeStore, repo: Repo): { oid: string; ref: string }[] {
  const result: { oid: string; ref: string }[] = [];
  const tip = store.resolve(repo, `refs/heads/${repo.defaultBranch}`);
  if (tip) result.push({ oid: tip, ref: 'HEAD' });
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    result.push({ oid, ref });
  }
  return result;
}

function peeledOid(store: ForgeStore, repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const obj = store.getObject(repo, current);
    if (!obj) return undefined;
    if (obj.type !== 'tag') return current;
    const target = parseTagTarget(obj.data);
    if (!target) return undefined;
    current = target.oid;
  }
  return undefined;
}

function advertisementV0(store: ForgeStore, repo: Repo, service: string): Buffer {
  const refs = refsForAdvertisement(store, repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta multi_ack_detailed no-done quiet shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=forge/1.0`
      : 'report-status side-band-64k delete-refs ofs-delta quiet agent=forge/1.0';
  const chunks: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (!refs.length) {
    chunks.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const capsPart = index === 0 ? `\0${caps}` : '';
      chunks.push(pkt(`${ref.oid} ${ref.ref}${capsPart}\n`));
    });
  }
  if (service === 'git-upload-pack') {
    for (const ref of refs) {
      if (!ref.ref.startsWith('refs/tags/')) continue;
      const peeled = peeledOid(store, repo, ref.oid);
      if (peeled && peeled !== ref.oid) chunks.push(pkt(`${peeled} ${ref.ref}^{}\n`));
    }
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function advertisementV2(store: ForgeStore, repo: Repo): Buffer {
  const chunks: Buffer[] = [
    pkt(`# service=git-upload-pack\n`),
    FLUSH,
    pkt('version 2\n'),
    pkt('agent=forge/1.0\n'),
    pkt('ls-refs\n'),
    pkt('fetch=shallow\n'),
    pkt('shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ];
  void store;
  void repo;
  return Buffer.concat(chunks);
}

function wantsFromBody(body: Buffer): {
  wants: string[];
  haves: string[];
  caps: Set<string>;
  lines: string[];
} {
  const framed = /^[0-9a-fA-F]{4}$/.test(body.subarray(0, 4).toString('latin1'));
  if (framed) return wantsFromPktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const caps = new Set<string>();
  const lines: string[] = [];
  for (const part of body.toString('utf8').split('\0')) {
    const text = part.trim();
    if (!text) continue;
    lines.push(text);
    const fields = text.split(/\s+/);
    if (fields[0] === 'want' && fields[1]) {
      wants.push(fields[1]);
      for (const cap of fields.slice(2)) caps.add(cap);
    } else if (fields[0] === 'have' && fields[1]) {
      haves.push(fields[1]);
    }
  }
  return { wants, haves, caps, lines };
}

function wantsFromPktLines(body: Buffer): {
  wants: string[];
  haves: string[];
  caps: Set<string>;
  lines: string[];
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const caps = new Set<string>();
  const lines: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    const special = parseInt(body.subarray(pos, pos + 4).toString('latin1'), 16);
    if (special === 1 || special === 2) {
      pos += 4;
      continue;
    }
    const entry = readPkt(body, pos);
    if (!entry) break;
    pos += entry.length;
    if (entry.length === 4 && entry.payload.length === 0 && pos < body.length) continue;
    const text = entry.payload.toString('utf8').replace(/\n$/, '');
    if (!text) continue;
    lines.push(text);
    const fields = text.split(/\s+/);
    if (fields[0] === 'want' && fields[1]) {
      wants.push(fields[1]);
      for (const cap of fields.slice(2)) caps.add(cap);
    } else if (fields[0] === 'have' && fields[1]) haves.push(fields[1]);
    else if (text === 'side-band-64k' || text === 'side-band') caps.add(text);
  }
  return { wants, haves, caps, lines };
}

function sideband(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const size = 4096;
  for (let i = 0; i < pack.length; i += size) {
    const piece = pack.subarray(i, i + size);
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), piece])));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function v2Refs(store: ForgeStore, repo: Repo, lines: string[]): Buffer {
  const prefixes = lines
    .filter((line) => line.startsWith('ref-prefix '))
    .map((line) => line.slice('ref-prefix '.length).trim())
    .filter(Boolean);
  const symrefs = lines.includes('symrefs');
  const peel = lines.includes('peel');
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const chunks: Buffer[] = [];
  for (const ref of refsForAdvertisement(store, repo)) {
    if (!keep(ref.ref)) continue;
    const attrs: string[] = [];
    if (symrefs && ref.ref === 'HEAD') attrs.push(`symref-target:refs/heads/${repo.defaultBranch}`);
    if (peel && ref.ref.startsWith('refs/tags/')) {
      const peeled = peeledOid(store, repo, ref.oid);
      if (peeled && peeled !== ref.oid) attrs.push(`peeled:${peeled}`);
    }
    const suffix = attrs.length ? ` ${attrs.join(' ')}` : '';
    chunks.push(pkt(`${ref.oid} ${ref.ref}${suffix}\n`));
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

async function handleUploadPackV2(
  store: ForgeStore,
  repo: Repo,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  const parsed = wantsFromPktLines(body);
  if (parsed.lines.includes('command=ls-refs')) {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(v2Refs(store, repo, parsed.lines));
    return;
  }
  const mode = parsed.lines.find((line) => line.startsWith('command='));
  if (mode && mode !== 'command=fetch') {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(FLUSH);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  if (!parsed.wants.length) {
    res.end(FLUSH);
    return;
  }
  const shape = fetchShape(parsed.lines);
  const plan = collectFetchObjects(store, repo, parsed.wants, parsed.haves, shape);
  const pack = packObjects(repo, plan.objects);
  const chunks: Buffer[] = [];
  if (plan.shallow.length || plan.unshallow.length) {
    chunks.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) chunks.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
    chunks.push(FLUSH);
  }
  // Protocol v2 always multiplexes the packfile section (side-band channel 1),
  // even when the client did not advertise side-band-64k in the fetch request.
  chunks.push(pkt('packfile\n'));
  chunks.push(sideband(pack));
  res.end(Buffer.concat(chunks));
}

async function handleUploadPackV0(
  store: ForgeStore,
  repo: Repo,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  const parsed = wantsFromBody(body);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  if (!parsed.wants.length) {
    res.end(Buffer.concat([pkt('NAK\n'), FLUSH]));
    return;
  }
  const shape = fetchShape(parsed.lines);
  const plan = collectFetchObjects(store, repo, parsed.wants, parsed.haves, shape);
  const pack = packObjects(repo, plan.objects);
  const chunks: Buffer[] = [];
  for (const oid of plan.shallow) chunks.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pkt(`unshallow ${oid}\n`));
  chunks.push(pkt('NAK\n'));
  chunks.push(parsed.caps.has('side-band-64k') ? sideband(pack) : pack);
  // Stateless HTTP v0: the NAK pkt-line is immediately followed by the
  // side-band framed pack (no extra flush packet in between).
  res.end(Buffer.concat(chunks));
}

interface RefCommand {
  old: string;
  next: string;
  ref: string;
}

async function handleReceivePack(
  store: ForgeStore,
  repo: Repo,
  body: Buffer,
  res: ServerResponse,
): Promise<void> {
  const commands: RefCommand[] = [];
  const caps = new Set<string>();
  let pos = 0;
  let first = true;
  while (pos + 4 <= body.length) {
    const marker = parseInt(body.subarray(pos, pos + 4).toString('latin1'), 16);
    if (marker === 0) { // flush separator: the packfile follows immediately
      pos += 4;
      break;
    }
    if (marker === 1 || marker === 2) { // delimiters used by protocol v2
      pos += 4;
      continue;
    }
    const entry = readPkt(body, pos);
    if (!entry) break;
    pos += entry.length;
    if (!entry.payload.length) continue;
    const text = entry.payload.toString('utf8');
    const [line, capabilityText] = text.split('\0');
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 3) {
      commands.push({ old: fields[0], next: fields[1], ref: fields[2] });
      if (first && capabilityText) {
        for (const cap of capabilityText.trim().split(/\s+/)) if (cap) caps.add(cap);
      }
    }
    first = false;
  }

  const packBody = body.subarray(pos);
  // A delete-only push carries command lines and a flush, with no packfile.
  if (packBody.length > 0) await parsePack(store, repo, packBody);

  const reports: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) || ZERO_OID;
    if (command.old !== current) {
      reports.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.next === ZERO_OID) {
      // The server advertised delete-refs; the client need not repeat that
      // capability in the command list for a delete to be valid.
      store.deleteRef(repo, command.ref);
      reports.push(`ok ${command.ref}\n`);
      continue;
    }
    if (current !== ZERO_OID && !store.isAncestor(repo, current, command.next)) {
      reports.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    store.setRef(repo, command.ref, command.next);
    reports.push(`ok ${command.ref}\n`);
  }

  const reportLines = [`unpack ok\n`, ...reports];
  const chunks: Buffer[] = [];
  if (caps.has('side-band-64k')) {
    // report-status itself is pkt-line framed; side-band wraps those pkt-lines in band 1.
    const framed = Buffer.concat([...reportLines.map((line) => pkt(line)), FLUSH]);
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), framed])));
    chunks.push(FLUSH);
  } else {
    for (const line of reportLines) chunks.push(pkt(line));
    chunks.push(FLUSH);
  }
  const output = Buffer.concat(chunks);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(output);
}

function isV2(req: IncomingMessage): boolean {
  const value = req.headers['git-protocol'];
  return Array.isArray(value) ? value.join(',').includes('version=2') : String(value || '').includes('version=2');
}

export async function handleGitRequest(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
): Promise<void> {
  if (segments.length < 3) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const owner = decodeURIComponent(segments[0]);
  const name = decodeURIComponent(segments[1]).replace(/\.git$/, '');
  const repo = store.getRepo(owner, name);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('repository not found');
    return;
  }
  const action = segments.slice(2).join('/');
  if (req.method === 'GET' && action === 'info/refs') {
    const service = url.searchParams.get('service') || '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('smart http only');
      return;
    }
    const body =
      service === 'git-upload-pack' && isV2(req)
        ? advertisementV2(store, repo)
        : advertisementV0(store, repo, service);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
    });
    res.end(body);
    return;
  }
  if (req.method === 'POST' && action === 'git-upload-pack') {
    const body = await readAll(req);
    if (isV2(req)) await handleUploadPackV2(store, repo, body, res);
    else await handleUploadPackV0(store, repo, body, res);
    return;
  }
  if (req.method === 'POST' && action === 'git-receive-pack') {
    const body = await readAll(req);
    await handleReceivePack(store, repo, body, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}
