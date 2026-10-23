import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createProxy } from './server.mjs';

async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = createProxy({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    apiKey: () => 'real-deepseek-key',
    proxyToken: () => 'colleague-token',
    ...options,
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    proxy.close();
    upstream.close();
  });
  return `http://127.0.0.1:${proxy.address().port}`;
}

const auth = { authorization: 'Bearer colleague-token' };
const post = (body = '{}') => ({ method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body });

test('browser preflight works for file://, localhost and hosted clients without authentication', async (t) => {
  const url = await fixture(t, () => assert.fail('Preflight reached DeepSeek'));
  for (const origin of ['null', 'http://localhost:8000', 'https://client.example']) {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'OPTIONS', headers: { origin, 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
  }
});

test('rejects missing/wrong credentials and arbitrary upstream paths', async (t) => {
  const url = await fixture(t, () => assert.fail('Rejected request reached upstream'));
  for (const headers of [{}, { authorization: 'Bearer incorrect' }]) {
    const response = await fetch(`${url}/models`, { headers });
    assert.equal(response.status, 401);
  }
  for (const path of ['/user/balance', '/v1/files', '//attacker.example/models']) {
    const response = await fetch(`${url}${path}`, { headers: auth });
    assert.equal(response.status, 404);
  }
  for (const path of ['/%2e%2e/models', 'https://attacker.example/models']) {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(url, { path, headers: auth }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 404);
  }
  assert.equal((await fetch(`${url}/chat/completions`, { headers: auth })).status, 405);
});

test('forwards request bytes/query, replaces auth and preserves JSON error status', async (t) => {
  const body = '{ "model": "test-model", "messages": [], "stream": false }';
  const url = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions?test=1');
    assert.equal(req.headers.authorization, 'Bearer real-deepseek-key');
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers.cookie, undefined);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), body);
    res.writeHead(429, {
      'content-type': 'application/json', 'retry-after': '3', 'x-request-id': 'upstream-id',
      'set-cookie': 'unwanted=true', 'access-control-allow-origin': 'https://wrong.example',
    });
    res.end('{"error":{"message":"quota"}}');
  });
  const request = post(body);
  request.headers.cookie = 'private=cookie';
  const response = await fetch(`${url}/v1/chat/completions?test=1`, request);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: { message: 'quota' } });
  assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(response.headers.get('x-request-id'), 'upstream-id');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('streams SSE before upstream completion and limits concurrent requests', async (t) => {
  let finish;
  const url = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    finish = () => res.end('data: [DONE]\n\n');
  }, { maxConcurrent: 1 });
  const response = await fetch(`${url}/chat/completions`, post('{"stream":true}'));
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
  const busy = await fetch(`${url}/models`, { headers: auth });
  assert.equal(busy.status, 429);
  finish();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), 'data: [DONE]\n\n');
  assert.equal((await reader.read()).done, true);
});

test('client cancellation closes upstream and releases the concurrency slot', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const url = await fixture(t, (req, res) => {
    if (req.url === '/models') return res.end('{"data":[]}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    res.on('close', upstreamClosed);
  }, { maxConcurrent: 1 });
  const controller = new AbortController();
  const response = await fetch(`${url}/chat/completions`, { ...post(), signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await closed;
  const next = await fetch(`${url}/models`, { headers: auth });
  assert.equal(next.status, 200);
  await next.text();
});

test('limits declared and chunked bodies, and rejects non-JSON requests', async (t) => {
  const url = await fixture(t, () => assert.fail('Oversized request reached upstream'), { maxBodyBytes: 4 });
  const oversized = await fetch(`${url}/chat/completions`, post('12345'));
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(`${url}/chat/completions`, {
    method: 'POST', headers: auth, body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${url}/chat/completions`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('123');
    req.end('456');
  });
  assert.equal(status, 413);
});

test('readiness and request credentials reflect secret rotation without restarting', async (t) => {
  let key = '';
  let token = 'colleague-token';
  const url = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    res.end('{}');
  }, { apiKey: () => key, proxyToken: () => token });
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/readyz`)).status, 503);
  key = 'new-deepseek-key';
  assert.equal((await fetch(`${url}/readyz`)).status, 200);
  assert.equal((await fetch(`${url}/models`, { headers: { 'x-api-key': token } })).status, 200);
  token = 'replacement-token';
  assert.equal((await fetch(`${url}/models`, { headers: auth })).status, 401);
  assert.equal((await fetch(`${url}/models`, { headers: { 'x-api-key': token } })).status, 200);
});

test('a stalled upstream returns 504', async (t) => {
  const url = await fixture(t, () => {}, { timeoutMs: 50 });
  const response = await fetch(`${url}/models`, { headers: auth });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error.message, /timed out/);
});
