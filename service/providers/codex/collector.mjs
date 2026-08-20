import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createCodexParserState, parseCodexRolloutLine } from './parser.mjs';
import { resolveCodexHome } from '../../utils.mjs';
import { UsageProviderAdapter } from '../contracts.mjs';

const READ_CHUNK_SIZE = 256 * 1024;

async function walkJsonlFiles(root) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(target);
    }
  }
  await walk(root);
  return files.sort();
}

async function readCompleteLines(filePath, startOffset, onLine) {
  const handle = await fsp.open(filePath, 'r');
  let position = startOffset;
  let carry = Buffer.alloc(0);
  try {
    const stat = await handle.stat();
    if (startOffset > stat.size) {
      return { finalOffset: 0, fileSize: stat.size, mtimeMs: stat.mtimeMs, truncated: true };
    }

    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) break;
      const chunk = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
      const chunkBaseOffset = position - carry.length;
      let lineStart = 0;
      while (true) {
        const newline = chunk.indexOf(0x0a, lineStart);
        if (newline === -1) break;
        const raw = chunk.subarray(lineStart, newline);
        const line = raw.length && raw[raw.length - 1] === 0x0d ? raw.subarray(0, -1).toString('utf8') : raw.toString('utf8');
        const lineEndOffset = chunkBaseOffset + newline + 1;
        await onLine(line, lineEndOffset);
        lineStart = newline + 1;
      }
      carry = Buffer.from(chunk.subarray(lineStart));
      position += bytesRead;
    }
    const finalOffset = stat.size - carry.length;
    return { finalOffset, fileSize: stat.size, mtimeMs: stat.mtimeMs, truncated: false };
  } finally {
    await handle.close();
  }
}

export class CodexCollector extends UsageProviderAdapter {
  constructor({ store, codexHome = resolveCodexHome(), reconcileIntervalMs = 5000 } = {}) {
    super({
      id: 'codex',
      name: 'Codex',
      measurement: 'local_observed',
      capabilities: { localLedger: true, serverQuota: true, hooks: true },
    });
    this.store = store;
    this.codexHome = codexHome;
    this.sessionsRoot = path.join(codexHome, 'sessions');
    this.archivedRoot = path.join(codexHome, 'archived_sessions');
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.watchers = new Map();
    this.scanInFlight = new Map();
    this.reconcileTimer = null;
    this.status = {
      provider: 'codex',
      detected: false,
      sessionsRoot: this.sessionsRoot,
      watching: false,
      lastScanAt: null,
      lastError: null,
      filesDiscovered: 0,
    };
  }

  async detect() {
    const roots = [this.sessionsRoot, this.archivedRoot];
    const checks = await Promise.all(roots.map(async (root) => {
      try { return (await fsp.stat(root)).isDirectory(); } catch { return false; }
    }));
    this.status.detected = checks.some(Boolean);
    return this.status.detected;
  }

  async discoverFiles() {
    const roots = [this.sessionsRoot, this.archivedRoot];
    const groups = await Promise.all(roots.map((root) => walkJsonlFiles(root)));
    const files = [...new Set(groups.flat())].sort();
    this.status.filesDiscovered = files.length;
    return files;
  }

  async scanFile(filePath, reason = 'reconcile') {
    if (this.scanInFlight.has(filePath)) return this.scanInFlight.get(filePath);
    const task = this.#scanFileInternal(filePath, reason).finally(() => this.scanInFlight.delete(filePath));
    this.scanInFlight.set(filePath, task);
    return task;
  }

  async #scanFileInternal(filePath, reason) {
    let scanState = this.store.getScanState(this.id, filePath);
    let startOffset = scanState?.byteOffset ?? 0;
    let previousUsage = scanState?.previousUsage ?? null;

    let currentStat;
    try {
      currentStat = await fsp.stat(filePath);
    } catch {
      return { changed: false, reason: 'missing' };
    }

    if (startOffset > currentStat.size) {
      this.store.resetScanState(this.id, filePath);
      scanState = null;
      startOffset = 0;
      previousUsage = null;
    }

    if (startOffset === currentStat.size && scanState?.mtimeMs === currentStat.mtimeMs) {
      return { changed: false, reason: 'unchanged' };
    }

    const storedSession = scanState?.sessionId ? this.store.getSession('codex', scanState.sessionId) : null;
    const parserState = createCodexParserState({ filePath, previousUsage, session: storedSession });
    let changed = false;
    let usageEvents = 0;
    let rateSnapshots = 0;
    let parseErrors = 0;

    const result = await readCompleteLines(filePath, startOffset, async (line, sourceOffset) => {
      const events = parseCodexRolloutLine(line, parserState);
      const observedAt = new Date().toISOString();
      for (const event of events) {
        if (event.type === 'session') {
          this.store.upsertSession(event.session, filePath, observedAt);
        } else if (event.type === 'usage') {
          if (this.store.insertUsageEvent(event, filePath, sourceOffset, observedAt)) {
            changed = true;
            usageEvents += 1;
          }
        } else if (event.type === 'rate_limits') {
          const inserted = this.store.insertRateLimits(event, filePath, sourceOffset, observedAt);
          if (inserted.length) {
            changed = true;
            rateSnapshots += inserted.length;
          }
        } else if (event.type === 'parse_error') {
          parseErrors += 1;
        }
      }
    });

    if (result.truncated) return this.#scanFileInternal(filePath, `${reason}:truncated`);

    this.store.saveScanState({
      provider: this.id,
      sourcePath: filePath,
      byteOffset: result.finalOffset,
      fileSize: result.fileSize,
      mtimeMs: result.mtimeMs,
      previousUsage: parserState.previousUsage,
      sessionId: parserState.session.sessionId,
    });

    this.status.lastScanAt = new Date().toISOString();
    this.status.lastError = null;
    if (changed) this.emit('updated', { provider: 'codex', filePath, reason, usageEvents, rateSnapshots });
    return { changed, usageEvents, rateSnapshots, parseErrors, finalOffset: result.finalOffset };
  }

  async reconcile(reason = 'interval') {
    try {
      await this.detect();
      if (!this.status.detected) return { changed: false, files: 0 };
      const files = await this.discoverFiles();
      let changed = false;
      for (const filePath of files) {
        const result = await this.scanFile(filePath, reason);
        changed ||= Boolean(result?.changed);
      }
      await this.refreshWatchers();
      this.status.lastScanAt = new Date().toISOString();
      this.status.lastError = null;
      return { changed, files: files.length };
    } catch (error) {
      this.status.lastError = String(error?.message ?? error);
      this.emit('error-state', { provider: 'codex', error: this.status.lastError });
      return { changed: false, error: this.status.lastError };
    }
  }

  async refreshWatchers() {
    const dirs = new Set();
    for (const root of [this.sessionsRoot, this.archivedRoot]) {
      async function walk(current) {
        let entries;
        try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
        dirs.add(current);
        for (const entry of entries) if (entry.isDirectory()) await walk(path.join(current, entry.name));
      }
      await walk(root);
    }

    for (const [dir, watcher] of this.watchers) {
      if (!dirs.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }

    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
          if (filename && String(filename).endsWith('.jsonl')) {
            const target = path.join(dir, String(filename));
            setTimeout(() => this.scanFile(target, 'fs-watch').catch(() => {}), 80);
          } else {
            setTimeout(() => this.reconcile('fs-watch-directory').catch(() => {}), 120);
          }
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // Periodic reconciliation remains the reliability fallback.
      }
    }
    this.status.watching = this.watchers.size > 0;
  }

  async start() {
    await this.reconcile('startup');
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => this.reconcile('interval'), this.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    }
    return this.getStatus();
  }

  stop() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.status.watching = false;
  }

  async handleHookSignal(payload = {}) {
    const transcriptPath = payload.transcript_path ?? payload.transcriptPath ?? null;
    if (transcriptPath && transcriptPath.endsWith('.jsonl')) {
      await this.scanFile(transcriptPath, `hook:${payload.hook_event_name ?? payload.event ?? 'unknown'}`);
    } else {
      await this.reconcile(`hook:${payload.hook_event_name ?? payload.event ?? 'unknown'}`);
    }
    this.emit('hook', payload);
  }

  getStatus() {
    return { ...this.status, watcherCount: this.watchers.size };
  }
}
