import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function hookSocketPath(appName = 'nyangtracker') {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${appName}-usage-hook`;
  return path.join(os.tmpdir(), `${appName}-${process.getuid?.() ?? 'user'}-usage-hook.sock`);
}

export class HookServer {
  constructor({ socketPath = hookSocketPath(), onSignal } = {}) {
    this.socketPath = socketPath;
    this.onSignal = onSignal;
    this.server = null;
  }

  async start() {
    if (this.server) return this.socketPath;
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch {}
    }
    this.server = net.createServer((socket) => {
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', async () => {
        try {
          const payload = JSON.parse(data || '{}');
          await this.onSignal?.(payload);
        } catch {}
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.socketPath, 0o600); } catch {}
    }
    return this.socketPath;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch {}
    }
  }
}

export async function sendHookSignal(payload, socketPath = hookSocketPath(), timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    socket.on('connect', () => {
      socket.end(JSON.stringify(payload ?? {}));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
