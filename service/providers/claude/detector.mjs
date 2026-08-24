import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Claude Code 의 설정 루트. CLAUDE_CONFIG_DIR 이 있으면 그것을 쓰고(경로를
// 콤마로 여러 개 줄 수 있습니다), 없으면 관례상의 두 위치를 봅니다. 두 번째
// 위치까지 보는 이유는 ccusage 와 같은 범위를 읽어야 대조가 의미를 갖기
// 때문입니다.
export function resolveClaudeHomes(env = process.env) {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (configured) {
    return configured
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry));
  }
  const home = os.homedir();
  return [path.join(home, '.claude'), path.join(home, '.config', 'claude')];
}

export function claudeProjectRoots(homes) {
  return homes.map((home) => path.join(home, 'projects'));
}

async function isDirectory(target) {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function detectClaudeRoots(roots) {
  const checks = await Promise.all(roots.map(async (root) => ({ root, exists: await isDirectory(root) })));
  return checks.filter((check) => check.exists).map((check) => check.root);
}

// 대화 transcript, 서브에이전트 transcript(<session>/subagents/agent-*.jsonl),
// 그리고 워크플로 에이전트(subagents/workflows/<run>/*.jsonl)가 모두 대상입니다.
// 레이아웃이 또 바뀔 수 있으므로 "projects 아래의 모든 .jsonl"로 넓게 잡고,
// 무엇이 어디에 있었는지는 파서가 경로에서 유추합니다.
export async function discoverClaudeTranscripts(root) {
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
      if (entry.isDirectory()) {
        // tool-results 는 도구 출력 본문이라 토큰이 없고 양이 많습니다.
        // 프라이버시상으로도 읽을 이유가 없어 통째로 건너뜁니다.
        if (entry.name === 'tool-results') continue;
        await walk(target);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(target);
      }
    }
  }
  await walk(root);
  return files.sort();
}
