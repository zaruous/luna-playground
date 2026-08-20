import os from 'node:os';
import path from 'node:path';

export function resolveCodexHome(env = process.env) {
  if (env.CODEX_HOME) return path.resolve(env.CODEX_HOME);
  return path.join(os.homedir(), '.codex');
}

export function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampNonNegative(value) {
  return Math.max(0, safeNumber(value));
}

export function extractSessionIdFromPath(filePath) {
  const match = String(filePath).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0] ?? path.basename(filePath, path.extname(filePath));
}

export function projectNameFromCwd(cwd) {
  if (!cwd) return 'unknown-project';
  const normalized = path.resolve(cwd);
  return path.basename(normalized) || normalized;
}

export function isoNow() {
  return new Date().toISOString();
}

export function quoteCommandPart(value, platform = process.platform) {
  const text = String(value);
  if (platform === 'win32') {
    return `"${text.replaceAll('"', '\\"')}"`;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}
