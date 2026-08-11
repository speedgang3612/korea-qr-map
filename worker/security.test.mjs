import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('./index.js', import.meta.url), 'utf8');
const workerModuleUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`;
const { default: worker } = await import(workerModuleUrl);

const allowedOrigin = 'https://korea-guide.kr';
const passLimiter = { limit: async () => ({ success: true }) };
const baseEnv = {
  API_RATE_LIMITER: passLimiter,
  TRANSLATE_RATE_LIMITER: passLimiter,
};

async function call(path, init = {}, env = baseEnv) {
  const headers = new Headers(init.headers || {});
  if (!headers.has('Origin')) headers.set('Origin', allowedOrigin);
  return worker.fetch(new Request(`https://worker.test${path}`, { ...init, headers }), env);
}

{
  const response = await call('/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
}

{
  const response = await call('/api/naver-search?query=test&display=21');
  assert.equal(response.status, 400);
}

{
  const response = await call('/api/kakao-category?code=ZZ9&x=127&y=37&radius=2000&size=15');
  assert.equal(response.status, 400);
}

{
  const response = await call('/api/kakao-keyword?query=test&x=127&y=37&radius=5001&size=15');
  assert.equal(response.status, 400);
}

{
  const response = await call('/api/deepl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid',
  });
  assert.equal(response.status, 400);
}

{
  const response = await call('/api/deepl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: Array(25).fill('a'), target_lang: 'EN' }),
  });
  assert.equal(response.status, 400);
}

{
  const response = await call('/api/naver-search?query=test', {}, {
    ...baseEnv,
    API_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
}

{
  const response = await call('/api/deepl', {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin);
}

console.log('Worker security tests passed.');
