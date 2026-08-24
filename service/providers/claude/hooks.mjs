import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveClaudeHomes } from './detector.mjs';

// docs/claude-code-adapter.md §11 의 v1 권고 목록입니다. UserPromptSubmit 은
// 토큰 정확성에 필요하지 않고 prompt 본문을 받게 되므로 넣지 않습니다.
// 이 다섯 개는 설치된 Claude Code 2.1.232 바이너리에 실제로 존재하는 이벤트
// 이름임을 확인했습니다.
const EVENTS = ['SessionStart', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop'];
const MARKER = '--nyangtracker-hook';

function isNyangHook(handler) {
  return handler?.type === 'command'
    && typeof handler.command === 'string'
    && handler.command.includes(MARKER);
}

// Claude 의 settings.json 은 hooks 외에 사용자 설정 전부를 담고 있습니다.
// 통째로 덮어쓰지 않고 우리 항목만 끼워 넣습니다(§12).
export function mergeClaudeHooks(existing, command) {
  const next = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  for (const eventName of EVENTS) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : [];
    const alreadyInstalled = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(isNyangHook));
    if (!alreadyInstalled) {
      // Stop/SessionStart 계열은 matcher 가 필요 없습니다(도구 이벤트 전용).
      groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
    }
    next.hooks[eventName] = groups;
  }
  return next;
}

export function removeNyangClaudeHooks(existing) {
  const next = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const eventName of EVENTS) {
    const groups = Array.isArray(next.hooks[eventName]) ? next.hooks[eventName] : null;
    if (!groups) continue;
    const kept = groups
      .map((group) => (Array.isArray(group?.hooks)
        ? { ...group, hooks: group.hooks.filter((handler) => !isNyangHook(handler)) }
        : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length) next.hooks[eventName] = kept;
    else delete next.hooks[eventName];
  }
  // 우리 항목만 있었다면 빈 hooks 껍데기를 남기지 않습니다.
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export class ClaudeHookInstaller {
  constructor({ claudeHomes = resolveClaudeHomes(), command, settingsPath = null } = {}) {
    this.command = command;
    // 여러 후보 홈 중 실제로 존재하는 첫 번째를 씁니다. 하나도 없으면 첫
    // 후보에 만듭니다 — 사용자가 명시적으로 설치를 눌렀을 때만 실행됩니다.
    this.claudeHome = claudeHomes[0];
    this.settingsPath = settingsPath ?? path.join(this.claudeHome, 'settings.json');
    this.backupPath = `${this.settingsPath}.nyangtracker.bak`;
  }

  async read() {
    try {
      const raw = await fsp.readFile(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('settings.json 의 최상위가 객체가 아닙니다');
      }
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new Error(`Claude settings.json을 읽지 못했습니다: ${error.message}`);
    }
  }

  async status() {
    let config;
    try {
      config = await this.read();
    } catch (error) {
      return { provider: 'claude', installed: false, state: 'conflict', error: error.message, settingsPath: this.settingsPath };
    }
    const installedEvents = EVENTS.filter((eventName) => (
      Array.isArray(config?.hooks?.[eventName])
      && config.hooks[eventName].some((group) => group?.hooks?.some(isNyangHook))
    ));
    const installed = installedEvents.length === EVENTS.length;
    return {
      provider: 'claude',
      installed,
      state: installed ? 'installed' : installedEvents.length ? 'partial' : 'not_installed',
      installedEvents,
      expectedEvents: EVENTS,
      settingsPath: this.settingsPath,
      command: this.command,
    };
  }

  async install() {
    await fsp.mkdir(path.dirname(this.settingsPath), { recursive: true });
    const current = await this.read();
    try {
      await fsp.access(this.settingsPath);
      try { await fsp.access(this.backupPath); } catch { await fsp.copyFile(this.settingsPath, this.backupPath); }
    } catch {}
    await this.write(mergeClaudeHooks(current, this.command));
    return this.status();
  }

  async uninstall() {
    const current = await this.read();
    await this.write(removeNyangClaudeHooks(current));
    return this.status();
  }

  async write(config) {
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    if (process.platform === 'win32') {
      await fsp.writeFile(this.settingsPath, contents);
      return;
    }
    const tempPath = `${this.settingsPath}.nyangtracker.tmp`;
    await fsp.writeFile(tempPath, contents, { mode: 0o600 });
    await fsp.rename(tempPath, this.settingsPath);
  }
}

export { EVENTS as CLAUDE_HOOK_EVENTS, MARKER as CLAUDE_HOOK_MARKER };
