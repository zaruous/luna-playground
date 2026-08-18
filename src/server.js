import http from 'node:http';

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/hello') {
      const name = url.searchParams.get('name')?.trim() || 'Luna';
      sendJson(res, 200, { message: `Hello, ${name}!` });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  const server = createServer();
  server.listen(port, () => {
    console.log(`luna-playground listening on http://localhost:${port}`);
  });
}
