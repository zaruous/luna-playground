import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageApiServer } from '../service/api-server.mjs';
import { hookSocketPath } from '../service/hook-server.mjs';
import { UsageEngine } from '../service/engine.mjs';
import { CodexHookInstaller } from '../service/providers/codex/hooks.mjs';
import { ClaudeHookInstaller } from '../service/providers/claude/hooks.mjs';
import { quoteCommandPart } from '../service/utils.mjs';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultUserDataPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'nyang-token-tracker');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'nyang-token-tracker');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'nyang-token-tracker');
}

export function hookCommand(script = 'codex-hook.mjs') {
  return `${quoteCommandPart(process.execPath)} ${quoteCommandPart(path.join(rootDir, 'scripts', script))} --nyangtracker-hook`;
}

export async function startUsageService({ host = '127.0.0.1', port = 0, staticRoot = null } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.NYANG_ALLOW_REMOTE !== '1') {
    throw new Error('원격 바인딩은 기본적으로 차단됩니다. 안전한 프록시와 인증을 구성한 뒤 NYANG_ALLOW_REMOTE=1을 명시하세요.');
  }

  const userDataPath = process.env.NYANG_USER_DATA || defaultUserDataPath();
  const usageEngine = new UsageEngine({ userDataPath });
  const hookInstallers = {
    codex: new CodexHookInstaller({ command: hookCommand('codex-hook.mjs') }),
    claude: new ClaudeHookInstaller({ command: hookCommand('claude-hook.mjs') }),
  };
  const apiServer = new UsageApiServer({ usageEngine, hookInstallers, host, port, staticRoot });
  let stopping = null;

  async function stop() {
    stopping ??= (async () => {
      await apiServer.stop();
      await usageEngine.stop();
    })();
    return stopping;
  }

  try {
    await usageEngine.start();
    const baseUrl = await apiServer.start();
    return { usageEngine, apiServer, baseUrl, hookInstallers, stop };
  } catch (error) {
    await stop().catch(() => {});
    if (error?.code === 'EADDRINUSE' && error.address === hookSocketPath()) {
      throw new Error(`냥토큰 트래커 사용량 서비스가 이미 실행 중입니다(hook 소켓 ${hookSocketPath()} 점유). 기존 프로세스를 종료한 뒤 다시 실행하세요.`, { cause: error });
    }
    throw error;
  }
}
