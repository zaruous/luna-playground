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

// warmup 기본값이 'background' 인 이유: 이 함수는 화면을 띄우는 프로세스가
// 부르는 입구입니다. 전량 스캔을 여기서 기다리면 로그가 많은 컴퓨터에서는
// 포트가 몇 분 동안 안 열리고, 밖에서 보면 "시작이 안 되는" 것과 구분되지
// 않습니다. 스캔은 워커에서 이어지고 진행 상황은 스냅샷에 실립니다.
export async function startUsageService({
  host = '127.0.0.1',
  port = 0,
  staticRoot = null,
  warmup = 'background',
} = {}) {
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
    // 이제 start 는 hook 소켓을 열고 로그 위치를 확인하는 데까지입니다.
    // 그래서 아래 listen 이 곧바로 실행되고 화면이 바로 열립니다.
    await usageEngine.start({ warmup });
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

// 백필은 화면이 뜬 뒤에도 계속 돕니다. 터미널에도 진행이 보여야 "멈춘 것"
// 으로 오해받지 않습니다 — 이 프로젝트가 겪은 증상이 정확히 그것이었습니다.
export function reportWarmupProgress(service, log = console.log) {
  const engine = service?.usageEngine;
  if (!engine) return () => {};

  const started = Date.now();
  let lastLine = null;

  const onSnapshot = (_snapshot, reason) => {
    if (reason?.type !== 'warmup') return;
    const warmup = engine.warmupState();

    if (warmup.phase === 'scanning') {
      if (!warmup.filesTotal) return;
      const line = `  로그 스캔 ${warmup.filesDone}/${warmup.filesTotal} (워커 ${warmup.workers}개)`;
      if (line === lastLine) return;
      lastLine = line;
      log(line);
      return;
    }

    if (warmup.phase === 'ready' || warmup.phase === 'failed') {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const perProvider = Object.entries(warmup.providers)
        .map(([id, entry]) => `${id} ${entry.filesDone}/${entry.filesTotal}${entry.error ? ' (오류)' : ''}`)
        .join(', ');
      if (warmup.phase === 'failed') log(`  로그 스캔 실패 (${seconds}초): ${warmup.error}`);
      else log(`  로그 스캔 완료 ${seconds}초 — ${perProvider || '스캔할 로그 없음'}`);
      engine.off('snapshot', onSnapshot);
    }
  };

  engine.on('snapshot', onSnapshot);
  return () => engine.off('snapshot', onSnapshot);
}
