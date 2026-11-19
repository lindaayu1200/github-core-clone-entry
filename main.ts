// Entrypoint: listen on an ephemeral port, register it, and wait for the environment to say done.
import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error('MAKEFUN_ENV_URL is not set; cannot register the server port.');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryForever<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  let delay = 50;
  while (true) {
    try {
      return await attempt();
    } catch (error) {
      console.error(`${label} failed (${(error as Error)?.message || error}); retrying in ${delay}ms`);
      await sleep(delay);
      delay = Math.min(1000, delay * 2);
    }
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
if (!address || typeof address === 'string') {
  console.error('Could not determine the listening port.');
  process.exit(1);
}
const port = address.port;
const base = envUrl.replace(/\/+$/, '');

await retryForever('register', async () => {
  const response = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await response.arrayBuffer();
});

await retryForever('done', async () => {
  const response = await fetch(`${base}/done`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { done?: boolean };
  if (payload?.done !== true) throw new Error('done is not true yet');
});

server.close(() => process.exit(0));
