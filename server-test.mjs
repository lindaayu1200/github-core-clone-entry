import http from 'node:http';
import { createApp } from './app.ts';

const server = createApp();
await new Promise((r) => server.listen(3900, r));
console.log('PORT=3900');
const req = (method, path, body, token = 'tok') => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const r = http.request({ host: '127.0.0.1', port: 3900, path, method, headers: {
    ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  } }, (res) => {
    const c = [];
    res.on('data', (x) => c.push(x));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() }));
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
const created = await req('POST', '/api/v3/user/repos', { name: 'gt' });
console.log('create-repo', created.status);
process.stdin.resume();
