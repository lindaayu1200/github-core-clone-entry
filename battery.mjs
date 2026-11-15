import http from 'node:http';

const req = (method, path, body, token = 'tok', raw = false) => new Promise((resolve, reject) => {
  const data = raw ? body : (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  const r = http.request({ host: '127.0.0.1', port: 3900, path, method, headers: {
    ...(data && data.length ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  } }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
  });
  r.on('error', reject);
  if (data && data.length) r.write(data);
  r.end();
});

const j = (r) => { try { return JSON.parse(r.body); } catch { return r.body; } };

// --- REST ---
console.log('root-noauth', (await req('GET', '/api/v3', undefined, '')).status);
const t = (await req('POST', '/api/v3/user/repos', { name: 'b1', description: 'd', private: true }));
console.log('create', t.status, 'reqid?', !!t.headers['x-github-request-id']);
console.log('dup-create', (await req('POST', '/api/v3/user/repos', { name: 'b1' })).status);
console.log('get', (await req('GET', '/api/v3/repos/owner/b1')).status);
console.log('get-other-owner', (await req('GET', '/api/v3/repos/someone/b1')).status);
console.log('patch', (await req('PATCH', '/api/v3/repos/owner/b1', { description: 'd2' })).status);
console.log('unknown-route', (await req('GET', '/api/v3/repos/owner/b1/nope')).status);
console.log('bad-json', (await req('POST', '/api/v3/user/repos', Buffer.from('{bad'), 'tok', true)).status);
console.log('404-json', (await req('GET', '/api/v3/nothing')).status);

// contents
const put1 = await req('PUT', '/api/v3/repos/owner/b1/contents/a.txt', { content: Buffer.from('v1').toString('base64'), message: 'm1' });
console.log('contents-put', put1.status, j(put1).commit?.sha ? 'commit-sha' : 'NO-SHA');
const sha1 = j(put1).content?.sha;
const put2 = await req('PUT', '/api/v3/repos/owner/b1/contents/a.txt', { content: Buffer.from('v2').toString('base64'), message: 'm2', sha: sha1 });
console.log('contents-put2', put2.status);
const put3 = await req('PUT', '/api/v3/repos/owner/b1/contents/a.txt', { content: Buffer.from('v3').toString('base64'), message: 'm3', sha: sha1 });
console.log('contents-conflict', put3.status);
const get1 = await req('GET', '/api/v3/repos/owner/b1/contents/a.txt');
console.log('contents-get', get1.status, Buffer.from(j(get1).content, 'base64').toString());
const get2 = await req('GET', '/api/v3/repos/owner/b1/contents/nope.txt');
console.log('contents-404', get2.status);
const putDir = await req('PUT', '/api/v3/repos/owner/b1/contents/sub/n.txt', { content: Buffer.from('n').toString('base64'), message: 'dir' });
console.log('contents-dir-put', putDir.status);
const getDir = await req('GET', '/api/v3/repos/owner/b1/contents/sub');
console.log('contents-dir-get', getDir.status, Array.isArray(j(getDir)) ? 'list' : typeof j(getDir));

// issues
const il = await req('POST', '/api/v3/repos/owner/b1/labels', { name: 'bug', color: 'ff0000' });
console.log('label', il.status);
const i1 = await req('POST', '/api/v3/repos/owner/b1/issues', { title: 'i1', body: 'b', labels: ['bug'] });
console.log('issue-create', i1.status, j(i1).number, j(i1).labels?.[0]?.name);
console.log('issue-badlabel', (await req('POST', '/api/v3/repos/owner/b1/issues', { title: 'x', labels: ['zzz'] })).status);
console.log('issue-get', (await req('GET', '/api/v3/repos/owner/b1/issues/1')).status);
console.log('issue-get-404', (await req('GET', '/api/v3/repos/owner/b1/issues/99')).status);
console.log('issue-close', j(await req('PATCH', '/api/v3/repos/owner/b1/issues/1', { state: 'closed' })).state);
console.log('issue-list-open', (j(await req('GET', '/api/v3/repos/owner/b1/issues?state=open'))).length);
console.log('issue-list-all', (j(await req('GET', '/api/v3/repos/owner/b1/issues?state=all'))).length);
console.log('comment', (await req('POST', '/api/v3/repos/owner/b1/issues/1/comments', { body: 'hi' })).status);

// pulls via branches: create branch via git ref API
const tip = j(await req('GET', '/api/v3/repos/owner/b1/git/refs/heads/main')).object?.sha;
console.log('ref-get', !!tip);
console.log('ref-create', (await req('POST', '/api/v3/repos/owner/b1/git/refs', { ref: 'refs/heads/feat', sha: tip })).status);
// make feat diverge: contents put on feat branch
await req('PUT', '/api/v3/repos/owner/b1/contents/feat.txt', { content: Buffer.from('f').toString('base64'), message: 'feat', branch: 'feat' });
const p1 = await req('POST', '/api/v3/repos/owner/b1/pulls', { title: 'pr1', head: 'feat', base: 'main' });
console.log('pr-create', p1.status, j(p1).number, j(p1).mergeable, j(p1).changed_files);
console.log('pr-files', j(await req('GET', '/api/v3/repos/owner/b1/pulls/2/files')).length);
const m1 = await req('PUT', '/api/v3/repos/owner/b1/pulls/2/merge', {});
console.log('pr-merge', m1.status, j(m1).merged, !!j(m1).sha);
console.log('pr-remerge', (await req('PUT', '/api/v3/repos/owner/b1/pulls/2/merge', {})).status);
// conflict pr: change a.txt on a branch from old base
const tip2 = j(await req('GET', '/api/v3/repos/owner/b1/git/refs/heads/main')).object.sha;
const branchOld = await req('POST', '/api/v3/repos/owner/b1/git/refs', { ref: 'refs/heads/cx', sha: tip2 });
console.log('ref-cx', branchOld.status);
// conflict: cx changes a.txt; then main also changes a.txt
await req('PUT', '/api/v3/repos/owner/b1/contents/a.txt', { content: Buffer.from('cx').toString('base64'), message: 'cx', branch: 'cx' });
await req('PUT', '/api/v3/repos/owner/b1/contents/a.txt', { content: Buffer.from('main').toString('base64'), message: 'main-chg', branch: 'main' });
const p2 = await req('POST', '/api/v3/repos/owner/b1/pulls', { title: 'pr-cx', head: 'cx', base: 'main' });
console.log('pr-conflict-mergeable', j(p2).mergeable);
console.log('pr-conflict-merge', (await req('PUT', '/api/v3/repos/owner/b1/pulls/3/merge', {})).status);

// --- GraphQL ---
const g1 = await req('POST', '/api/graphql', { query: '{ repository(owner:"owner", name:"b1") { id databaseId name nameWithOwner owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }' });
console.log('gql-repo', g1.status, j(g1).data?.repository?.nameWithOwner, j(g1).data?.repository?.databaseId);
const repoId = j(g1).data?.repository?.id;
const g2 = await req('POST', '/api/graphql', { query: 'query($o:String!,$n:String!){ repository(owner:$o, name:$n) { issues(first:10, states:[OPEN], orderBy:{field:CREATED_AT, direction:DESC}) { nodes { number title state } pageInfo { hasNextPage } } } }', variables: { o: 'owner', n: 'b1' } });
console.log('gql-issues', j(g2).data?.repository?.issues?.nodes?.length, j(g2).data?.repository?.issues?.nodes?.[0]?.state);
const g3 = await req('POST', '/api/graphql', { query: '{ __type(name:"Issue") { name fields { name } } __type(name:"SearchType") { name enumValues { name } } }' });
console.log('gql-introspect', j(g3).data?.__type?.length === 2 ? JSON.stringify(j(g3).data) : 'parsed');
const it = j(g3).data;
console.log('gql-issue-fields', (it?.[0]?.fields ?? it?.['0']?.fields ?? []).map?.(f => f.name)?.slice?.(0,4));
console.log('gql-unknown-repo', j(await req('POST', '/api/graphql', { query: '{ repository(owner:"a", name:"zzz") { id } }' })).data?.repository);
const g4 = await req('POST', '/api/graphql', { query: '{ repository(owner:"owner", name:"b1") { bogus } }' });
console.log('gql-unknown-field', g4.status, Array.isArray(j(g4).errors), j(g4).data?.repository?.bogus);
const g5 = await req('POST', '/api/graphql', { query: 'mutation($inp:CreateIssueInput!){ createIssue(input:$inp) { issue { number state } } }', variables: { inp: { repositoryId: repoId, title: 'from-gql' } } });
console.log('gql-createIssue', j(g5).data?.createIssue?.issue?.number, j(g5).data?.createIssue?.issue?.state);
const g6 = await req('POST', '/api/graphql', { query: '{ repository(owner:"owner", name:"b1") { pullRequest(number:2) { number headRefName baseRefName mergeable state merged files(first:5) { totalCount nodes { path additions } } } } }' });
console.log('gql-pr', JSON.stringify(j(g6).data?.repository?.pullRequest)?.slice(0, 200));
const g7 = await req('POST', '/api/graphql', { query: '{ a: repository(owner:"owner", name:"b1") { id } b: viewer { login } }' });
console.log('gql-aliases', !!j(g7).data?.a?.id, j(g7).data?.b?.login);
// batched: two operations in one body answered in order
const g8 = await req('POST', '/api/graphql', { query: 'query A { viewer { login } } query B { viewer { login } }', operationName: 'B' });
console.log('gql-opname', j(g8).data?.viewer?.login);
const g9 = await req('POST', '/api/graphql', [{ query: '{ viewer { login } }' }, { query: '{ viewer { login } }' }]);
console.log('gql-batch', Array.isArray(j(g9)) && j(g9).length === 2);

// --- MCP ---
const m1r = await req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
console.log('mcp-init', j(m1r).result?.protocolVersion, j(m1r).result?.serverInfo?.name);
const m2 = await req('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'server/discover' });
console.log('mcp-discover', j(m2).result?.resultType, (j(m2).result?.supportedVersions ?? []).includes('2026-07-28'));
const m3 = await req('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' });
console.log('mcp-tools', j(m3).result?.tools?.length);
console.log('mcp-suffix', j(m3).result?.tools?.some(t => t.name.endsWith('create_issue')), j(m3).result?.tools?.some(t => t.name.endsWith('merge_pull_request')));
const m4 = await req('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'mcp-repo', private: false } } });
console.log('mcp-createRepo', j(m4).result?.content?.[0]?.text ? 'text-ok' : 'FAIL');
const m5 = await req('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'owner', repo: 'mcp-repo', title: 'mcp-issue' } } });
console.log('mcp-createIssue', j(m5).result?.content?.[0]?.text ? 'ok' : 'FAIL');
const m6 = await req('POST', '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'owner', repo: 'mcp-repo' } } });
console.log('mcp-listIssues', JSON.parse(j(m6).result.content[0].text).length);
console.log('mcp-badargs', JSON.stringify(j(await req('POST', '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'owner', repo: 'mcp-repo' } } }))).slice(0, 140));
console.log('mcp-unknownmethod', j(await req('POST', '/mcp', { jsonrpc: '2.0', id: 8, method: 'bogus/x' })).error?.code);
console.log('mcp-unknowntool', j(await req('POST', '/mcp', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope', arguments: {} } })).error?.code);
console.log('mcp-badjson', j(await req('POST', '/mcp', Buffer.from('{bad'), 'tok', true)));
console.log('mcp-noauth', (await req('POST', '/mcp', { jsonrpc: '2.0', id: 10, method: 'tools/list' }, '')).status);
console.log('mcp-notification', (await req('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status);
const m7 = await req('POST', '/mcp', [
  { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'get_issue', arguments: { owner: 'owner', repo: 'mcp-repo', issue_number: 1 } } },
  { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'get_issue', arguments: { owner: 'owner', repo: 'mcp-repo', issue_number: 99 } } },
]);
console.log('mcp-batch', Array.isArray(j(m7)), j(m7).length);
console.log('mcp-same-store', j(await req('GET', '/api/v3/repos/owner/mcp-repo/issues?state=all')).length, 1);
process.exit(0);
