import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const API_PREFIX = '/api/v1';
const HOOK_ROUTE = new RegExp(`^${API_PREFIX}/providers/([a-z0-9_-]+)/hooks$`);
const SESSION_FLOW_ROUTE = new RegExp(`^${API_PREFIX}/sessions/([^/]+)/flow$`);
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

// 프로젝트 라우트: 키는 16자리 해시만 허용합니다 (원본 경로 URL 유입 차단).
const PROJECT_ROUTE = new RegExp(`^${API_PREFIX}/projects/([a-f0-9]{16})(/alias)?$`);

// 별칭 본문만 받으므로 상한을 작게 둡니다.
async function readJsonBody(req, limitBytes = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
    hookInstallers = null,
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
    // provider 마다 hook 설정 파일이 다릅니다. 기존 hookInstaller 인자는
    // Codex 용으로 그대로 받아 맵에 합침니다.
    this.hookInstallers = new Map(Object.entries(hookInstallers ?? {}));
    if (hookInstaller && !this.hookInstallers.has('codex')) this.hookInstallers.set('codex', hookInstaller);
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
      await this.#handleApi(req, res, url);
      return;
    }
    await this.#serveStatic(req, res, url.pathname);
  }

  async #handleApi(req, res, url) {
    const pathname = url.pathname;
    const query = url.searchParams;
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
    const hookRoute = pathname.match(HOOK_ROUTE);
    if (hookRoute) {
      const installer = this.hookInstallers.get(hookRoute[1]);
      if (!installer) {
        json(res, 503, { error: 'hooks_unavailable' });
        return;
      }
      if (req.method === 'GET') json(res, 200, await installer.status());
      else if (req.method === 'POST') json(res, 200, await installer.install());
      else if (req.method === 'DELETE') json(res, 200, await installer.uninstall());
      else json(res, 405, { error: 'method_not_allowed' });
      return;
    }
    // 세션 흐름 화면(docs/dev/menus/session.md). sessionId 는 provider 가 만든
    // UUID 이므로 URL 에 넣어도 경로가 새지 않습니다.
    if (req.method === 'GET' && pathname === `${API_PREFIX}/sessions`) {
      json(res, 200, {
        sessions: this.usageEngine.store.getSessionRanking({
          provider: query.get('provider'),
          since: query.get('since') ?? this.usageEngine.defaultSince(),
          until: query.get('until'),
          limit: Number(query.get('limit')) || 30,
        }),
      });
      return;
    }
    const sessionFlowRoute = pathname.match(SESSION_FLOW_ROUTE);
    if (req.method === 'GET' && sessionFlowRoute) {
      const flow = this.usageEngine.store.getSessionFlow({
        provider: query.get('provider') ?? 'claude',
        sessionId: decodeURIComponent(sessionFlowRoute[1]),
      });
      if (!flow) {
        json(res, 404, { error: 'session_not_found' });
        return;
      }
      json(res, 200, flow);
      return;
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/usage/timeseries`) {
      json(res, 200, this.usageEngine.store.getUsageTimeseries({
        provider: query.get('provider'),
        model: query.get('model'),
        bucket: query.get('bucket') ?? 'day',
        since: query.get('since') ?? this.usageEngine.defaultSince(),
        until: query.get('until'),
      }));
      return;
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/usage/models`) {
      json(res, 200, this.usageEngine.store.getModelBreakdown({
        provider: query.get('provider'),
        since: query.get('since') ?? this.usageEngine.defaultSince(),
        until: query.get('until'),
      }));
      return;
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/projects`) {
      json(res, 200, {
        projects: this.usageEngine.store.getProjectBreakdown({
          provider: query.get('provider'),
          since: query.get('since') ?? this.usageEngine.defaultSince(),
          until: query.get('until'),
          limit: Number(query.get('limit')) || 100,
        }),
      });
      return;
    }
    if (req.method === 'GET' && pathname === `${API_PREFIX}/quota/history`) {
      json(res, 200, this.usageEngine.store.getQuotaHistory({
        provider: query.get('provider') ?? 'codex',
        limitId: query.get('limitId'),
        windowMinutes: query.get('windowMinutes'),
        since: query.get('since'),
      }));
      return;
    }
    const projectMatch = pathname.match(PROJECT_ROUTE);
    if (projectMatch) {
      const [, projectKey, aliasPath] = projectMatch;
      if (!aliasPath && req.method === 'GET') {
        const detail = this.usageEngine.store.getProjectDetail({
          projectKey,
          since: query.get('since') ?? this.usageEngine.defaultSince(),
          until: query.get('until'),
        });
        if (!detail) json(res, 404, { error: 'project_not_found' });
        else json(res, 200, detail);
        return;
      }
      if (aliasPath && req.method === 'PUT') {
        const body = await readJsonBody(req).catch(() => null);
        if (!body || typeof body !== 'object') {
          json(res, 400, { error: 'invalid_body' });
          return;
        }
        this.usageEngine.store.setProjectAlias({
          provider: typeof body.provider === 'string' ? body.provider : 'codex',
          projectKey,
          alias: typeof body.alias === 'string' ? body.alias.slice(0, 80) : '',
          redacted: Boolean(body.redacted),
        });
        json(res, 200, this.usageEngine.snapshot());
        return;
      }
      json(res, 405, { error: 'method_not_allowed' });
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
