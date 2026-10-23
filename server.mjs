import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const routes = new Map([
  ['/chat/completions', 'POST'],
  ['/v1/chat/completions', 'POST'],
  ['/responses', 'POST'],
  ['/v1/responses', 'POST'],
  ['/models', 'GET'],
  ['/v1/models', 'GET'],
]);

function secret(name) {
  const file = process.env[`${name}_FILE`];
  try {
    return (file ? readFileSync(file, 'utf8') : process.env[name] ?? '').trim();
  } catch {
    return '';
  }
}

function sameToken(actual, expected) {
  const hash = (value) => createHash('sha256').update(value).digest();
  return Boolean(actual && expected) && timingSafeEqual(hash(actual), hash(expected));
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function fail(res, status, message) {
  json(res, status, { error: { message, type: 'proxy_error', code: status } });
}

// The upstream override is for local integration tests. Production always uses DeepSeek.
export function createProxy({
  apiKey = () => secret('DEEPSEEK_API_KEY'),
  proxyToken = () => secret('PROXY_TOKEN'),
  upstream = 'https://api.deepseek.com',
  maxBodyBytes = 8 * 1024 * 1024,
  maxConcurrent = 8,
  timeoutMs = 600_000,
} = {}) {
  const origin = new URL(upstream);
  const transport = origin.protocol === 'https:' ? https : http;
  let active = 0;

  const server = http.createServer(async (req, res) => {
    // Includes Origin: null from HTML opened directly from the local filesystem.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, X-API-Key');
    res.setHeader('access-control-expose-headers', 'X-Request-ID, Retry-After');
    res.setHeader('access-control-max-age', '600');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');

    if (req.url === '/healthz' && req.method === 'GET') {
      return json(res, 200, { status: 'ok' });
    }
    if (req.url === '/readyz' && req.method === 'GET') {
      const ready = Boolean(apiKey() && proxyToken());
      return json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'missing_credentials' });
    }

    // Match the raw path before constructing a URL; absolute URLs and traversal are rejected.
    const path = req.url.split('?')[0];
    const method = routes.get(path);
    if (!method) return fail(res, 404, 'Unknown API endpoint.');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== method) {
      res.setHeader('allow', `${method}, OPTIONS`);
      return fail(res, 405, 'Method not allowed.');
    }

    const token = proxyToken();
    if (!token) return fail(res, 503, 'Proxy credentials are not configured.');
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!sameToken(bearer ?? req.headers['x-api-key'] ?? '', token)) {
      res.setHeader('www-authenticate', 'Bearer');
      return fail(res, 401, 'A valid proxy token is required.');
    }
    const key = apiKey();
    if (!key) return fail(res, 503, 'DeepSeek API key is not configured.');
    if (active >= maxConcurrent) {
      res.setHeader('retry-after', '10');
      return fail(res, 429, 'Proxy is busy; retry shortly.');
    }
    if (method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return fail(res, 415, 'Content-Type must be application/json.');
    }
    if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) {
      return fail(res, 413, 'Request body is too large.');
    }

    active += 1;
    let outgoing;
    let timedOut = false;
    const cancel = () => {
      if (!res.writableFinished) outgoing?.destroy(new Error('Client disconnected'));
    };
    res.on('close', cancel);
    const timer = setTimeout(() => {
      timedOut = true;
      if (outgoing) outgoing.destroy(new Error('Upstream timeout'));
      else req.destroy();
    }, timeoutMs);
    timer.unref();

    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          res.setHeader('connection', 'close');
          fail(res, 413, 'Request body is too large.');
          return;
        }
        chunks.push(chunk);
      }
      if (res.destroyed) return;
      const body = Buffer.concat(chunks);
      const target = new URL(req.url, origin);
      const headers = {
        authorization: `Bearer ${key}`,
        accept: req.headers.accept ?? 'application/json',
        'accept-encoding': 'identity',
      };
      if (method === 'POST') {
        headers['content-type'] = req.headers['content-type'];
        headers['content-length'] = body.length;
      }

      const response = await new Promise((resolve, reject) => {
        outgoing = transport.request(target, { method, headers }, resolve);
        outgoing.on('error', reject);
        outgoing.end(method === 'POST' ? body : undefined);
      });

      // Forward only API response metadata, never cookies, redirects or upstream CORS.
      for (const name of ['content-type', 'content-encoding', 'x-request-id', 'retry-after']) {
        if (response.headers[name] !== undefined) res.setHeader(name, response.headers[name]);
      }
      res.setHeader('x-accel-buffering', 'no');
      res.writeHead(response.statusCode);
      res.flushHeaders();
      // No buffering: SSE chunks reach the browser immediately, with backpressure.
      await pipeline(response, res);
    } catch {
      if (!res.headersSent && !res.destroyed) {
        fail(res, timedOut ? 504 : 502, timedOut ? 'DeepSeek request timed out.' : 'DeepSeek is unavailable.');
      } else if (!res.destroyed) {
        res.destroy();
      }
    } finally {
      clearTimeout(timer);
      res.off('close', cancel);
      outgoing?.destroy();
      active -= 1;
    }
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const server = createProxy();
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, '0.0.0.0', () => console.log(`DeepSeek proxy listening on ${port}`));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 25_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
