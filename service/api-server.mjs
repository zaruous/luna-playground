import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const API_PREFIX = '/api/v1';
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''));
  const rightBuffer = Buffer.from(String(right ?? ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function clientConfigScript(config) {
  const serialized = JSON.stringify(config).replaceAll('<', '\\u003c');
  return `<script>window.__NYANG_TRACKER_CONFIG__=${serialized};</script>`;
}

function isWithinRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export class UsageApiServer {
  constructor({
    usageEngine,
    hookInstaller,
    host = '127.0.0.1',
    port = 0,
    accessToken = crypto.randomBytes(32).toString('base64url'),
    staticRoot = null,
    heartbeatMs = 20_000,
    allowedOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'],
  } = {}) {
    if (!usageEngine) throw new TypeError('usageEngine is required');
    this.usageEngine = usageEngine;
    this.hookInstaller = hookInstaller;
    this.host = host;
    this.port = port;
    this.accessToken = accessToken;
    this.staticRoot = staticRoot ? path.resolve(staticRoot) : null;
    this.heartbeatMs = heartbeatMs;
    this.allowedOrigins = new Set(allowedOrigins);
    this.server = null;
    this.baseUrl = null;
    this.clients = new Set();
    this.revision = 1;
    this.heartbeat = null;
    this.onSnapshot = (snapshot, reason) => this.broadcast(snapshot, reason);
  }

  async start() {
    if (this.server) return this.baseUrl;
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        if (!res.headersSent) json(res, 500, { error: 'internal_error', message: error.message });
        else res.destroy(error);
      });
    });
    this.server.keepAliveTimeout = 65_000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    const displayHost = this.host.includes(':') ? `[${this.host}]` : this.host;
    this.baseUrl = `http://${displayHost}:${address.port}`;
    this.usageEngine.on('snapshot', this.onSnapshot);
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(`: heartbeat ${Date.now()}\n\n`);
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
    return this.baseUrl;
  }

  async stop() {
    if (!this.server) return;
    this.usageEngine.off('snapshot', this.onSnapshot);
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    server.closeIdleConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  clientConfig() {
    return {
      platform: process.platform,
      runtime: 'browser',
      transport: { kind: 'http-sse', baseUrl: this.baseUrl, accessToken: this.accessToken },
    };
  }

  broadcast(snapshot, reason = null) {
    this.revision += 1;
    const message = this.#snapshotEvent(snapshot, reason);
    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) this.clients.delete(client);
      else client.write(message);
    }
  }

  #snapshotEvent(snapshot, reason) {
    return `id: ${this.revision}\nevent: snapshot\ndata: ${JSON.stringify({ snapshot, reason: reason ?? null })}\n\n`;
  }

  #applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const ownOrigin = this.baseUrl && origin === this.baseUrl;
    if (!ownOrigin && !this.allowedOrigins.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Nyang-Access-Token');
    return true;
  }

  #authorized(req, url) {
    const headerToken = req.headers['x-nyang-access-token'];
    const queryToken = url.searchParams.get('access_token');
    return safeEqual(headerToken ?? queryToken, this.accessToken);
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', this.baseUrl ?? `http://${this.host}`);
    if (!this.#applyCors(req, res)) {
      json(res, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (url.pathname === '/healthz' && req.method === 'GET') {
      json(res, 200, { ok: true, service: 'nyang-token-tracker' });
      return;
    }
    if (url.pathname.startsWith(API_PREFIX)) {
      if (!this.#authorized(req, url)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      await this.#handleApi(req, res, url.pathname);
      return;
    }
    await this.#serveStatic(req, res, url.pathname);
  }

  async #handleApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === `${API_PREFIX}/snapshot`) {
      json(res, 200, this.usageEngine.snapshot());
      return;
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/events`) {
      this.#openEventStream(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === `${API_PREFIX}/rescan`) {
      json(res, 200, await this.usageEngine.rescan());
      return;
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/diagnostics`) {
      json(res, 200, this.usageEngine.store.getDiagnostics());
      return;
    }
    if (pathname === `${API_PREFIX}/providers/codex/hooks`) {
      if (!this.hookInstaller) {
        json(res, 503, { error: 'hooks_unavailable' });
        return;
      }
      if (req.method === 'GET') json(res, 200, await this.hookInstaller.status());
      else if (req.method === 'POST') json(res, 200, await this.hookInstaller.install());
      else if (req.method === 'DELETE') json(res, 200, await this.hookInstaller.uninstall());
      else json(res, 405, { error: 'method_not_allowed' });
      return;
    }
    json(res, 404, { error: 'not_found' });
  }

  #openEventStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    req.socket.setKeepAlive?.(true);
    this.clients.add(res);
    res.write('retry: 3000\n\n');
    res.write(this.#snapshotEvent(this.usageEngine.snapshot(), { type: 'connected' }));
    req.on('close', () => this.clients.delete(res));
  }

  async #serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (!this.staticRoot) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    let decodedPath;
    try { decodedPath = decodeURIComponent(pathname); } catch {
      json(res, 400, { error: 'invalid_path' });
      return;
    }
    const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
    let filePath = path.resolve(this.staticRoot, relativePath);
    if (!isWithinRoot(this.staticRoot, filePath)) {
      json(res, 403, { error: 'invalid_path' });
      return;
    }
    let contents;
    try {
      contents = await fs.readFile(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !String(req.headers.accept ?? '').includes('text/html')) {
        if (error?.code === 'ENOENT') json(res, 404, { error: 'not_found' });
        else throw error;
        return;
      }
      filePath = path.join(this.staticRoot, 'index.html');
      contents = await fs.readFile(filePath);
    }
    if (path.extname(filePath) === '.html') {
      const html = contents.toString('utf8').replace('</head>', `${clientConfigScript(this.clientConfig())}</head>`);
      contents = Buffer.from(html);
    }
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
      'Content-Length': contents.length,
      'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(contents);
  }
}
