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
  const response = await call('/api/kakao-route?mode=car&start_x=127&start_y=37&end_x=127.1&end_y=37.1');
  assert.equal(response.status, 400);
}

{
  const response = await call('/api/kakao-route?mode=walk&start_x=0&start_y=0&end_x=127.1&end_y=37.1');
  assert.equal(response.status, 400);
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'OK',
    route: {
      properties: {
        totalDistance: 820,
        totalTime: 720,
        landingUrl: 'https://map.kakao.com/link/by/walk/example',
      },
      legs: [{
        steps: [{
          properties: {
            distance: 120,
            time: 90,
            guidance: '명동역 방향으로 직진',
            x: 126.98,
            y: 37.56,
          },
          path: { points: [[126.98, 37.56]] },
        }],
      }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const response = await call(
      '/api/kakao-route?mode=walk&start_x=126.978&start_y=37.5665&end_x=126.9863&end_y=37.561&name=Myeongdong',
      {},
      { ...baseEnv, KAKAO_REST_KEY: 'test-key' },
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.mode, 'walk');
    assert.equal(data.summary.distance, 820);
    assert.equal(data.steps[0].guidance, '명동역 방향으로 직진');
    assert.equal('path' in data.steps[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
