import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexHome } from '../../utils.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const MARKER = '--nyangtracker-hook';

function isNyangHook(handler) {
  return handler?.type === 'command' && typeof handler.command === 'string' && handler.command.includes(MARKER);
}

export function mergeCodexHooks(existing, command) {
  const next = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  next.description ||= 'User hooks. NyangTracker entries are added without replacing other hooks.';
  next.hooks ||= {};
  for (const eventName of EVENTS) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    const alreadyInstalled = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isNyangHook));
    if (!alreadyInstalled) {
      groups.push({
        hooks: [{ type: 'command', command, timeout: 2, async: true, statusMessage: '냥트랙커 사용량 동기화' }],
      });
    }
    next.hooks[eventName] = groups;
  }
  return next;
}

export function removeNyangCodexHooks(existing) {
  const next = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  next.hooks ||= {};
  for (const eventName of EVENTS) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    next.hooks[eventName] = groups
      .map((group) => ({ ...group, hooks: Array.isArray(group?.hooks) ? group.hooks.filter((handler) => !isNyangHook(handler)) : [] }))
      .filter((group) => group.hooks.length > 0);
  }
  return next;
}

export class CodexHookInstaller {
  constructor({ codexHome = resolveCodexHome(), command }) {
    this.codexHome = codexHome;
    this.command = command;
    this.hooksPath = path.join(codexHome, 'hooks.json');
    this.backupPath = path.join(codexHome, 'hooks.json.nyangtracker.bak');
  }

  async read() {
    try {
      return JSON.parse(await fsp.readFile(this.hooksPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new Error(`Codex hooks.json을 읽지 못했습니다: ${error.message}`);
    }
  }

  async status() {
    let config;
    try { config = await this.read(); } catch (error) { return { installed: false, error: error.message, hooksPath: this.hooksPath }; }
    const installedEvents = EVENTS.filter((eventName) => (
      Array.isArray(config?.hooks?.[eventName]) && config.hooks[eventName].some((group) => group?.hooks?.some(isNyangHook))
    ));
    return {
      installed: installedEvents.length === EVENTS.length,
      installedEvents,
      expectedEvents: EVENTS,
      hooksPath: this.hooksPath,
      command: this.command,
    };
  }

  async install() {
    await fsp.mkdir(this.codexHome, { recursive: true });
    const current = await this.read();
    try {
      await fsp.access(this.hooksPath);
      try { await fsp.access(this.backupPath); } catch { await fsp.copyFile(this.hooksPath, this.backupPath); }
    } catch {}
    const next = mergeCodexHooks(current, this.command);
    await this.write(next);
    return this.status();
  }

  async uninstall() {
    const current = await this.read();
    const next = removeNyangCodexHooks(current);
    await this.write(next);
    return this.status();
  }

  async write(config) {
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    if (process.platform === 'win32') {
      await fsp.writeFile(this.hooksPath, contents);
      return;
    }
    const tempPath = `${this.hooksPath}.nyangtracker.tmp`;
    await fsp.writeFile(tempPath, contents, { mode: 0o600 });
    await fsp.rename(tempPath, this.hooksPath);
  }
}
