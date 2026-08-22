import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export { toBytes, readVarint, scanProtobuf } from './antigravity-protobuf.mjs';

// Gemini CLI 는 세션을 `<home>/tmp/<프로젝트 디렉터리>/chats/*.json` 에 남깁니다.
// 공식 환경변수는 확인하지 못했으므로 홈 한 곳만 보고, 테스트가 다른 위치를
// 가리킬 수 있게 NYANG_GEMINI_HOME 을 둡니다.
export function resolveGeminiHomes(env = process.env) {
  if (env.NYANG_GEMINI_HOME) return [path.resolve(env.NYANG_GEMINI_HOME)];
  return [path.join(os.homedir(), '.gemini')];
}

// agy(Antigravity CLI) 는 ~/.gemini/antigravity-cli 아래에 SQLite 를 둡니다.
// 테스트가 다른 위치를 가리킬 수 있게 NYANG_ANTIGRAVITY_HOME 을 둡니다.
export function resolveAntigravityHome(env = process.env) {
  if (env.NYANG_ANTIGRAVITY_HOME) return path.resolve(env.NYANG_ANTIGRAVITY_HOME);
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

export function antigravityConversationsDir(antigravityHome) {
  return path.join(antigravityHome, 'conversations');
}

// 감지만 합니다 — DB 를 열지 않고 conversations/*.db 의 존재와 mtime 을 봅니다.
export async function detectAntigravity(antigravityHome) {
  const conversationsDir = antigravityConversationsDir(antigravityHome);
  let conversationCount = 0;
  let lastActivityAt = null;
  try {
    const entries = await fsp.readdir(conversationsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
      conversationCount += 1;
      const stat = await fsp.stat(path.join(conversationsDir, entry.name));
      const mtime = stat.mtime.toISOString();
      if (!lastActivityAt || mtime > lastActivityAt) lastActivityAt = mtime;
    }
  } catch {
    return { present: false, conversationCount: 0, lastActivityAt: null };
  }
  return {
    present: conversationCount > 0,
    conversationCount,
    lastActivityAt,
  };
}

// 세션 루트는 GEMINI_DATA_DIR 로 옮길 수 있습니다
// (docs/dev/provider-token-api.md §5.4). 이 변수는 홈이 아니라 `tmp` 자리를
// 대체하므로 projects.json 은 그대로 홈에서 읽습니다.
export function geminiProjectRoots(homes, env = process.env) {
  if (env.GEMINI_DATA_DIR) return [path.resolve(env.GEMINI_DATA_DIR)];
  return homes.map((home) => path.join(home, 'tmp'));
}

// 세션 파일은 두 포맷입니다. 실측(개발 머신): `.json` 419개, `.jsonl` 386개.
//   `.json`  문서 전체 스냅샷 — 매번 재작성되므로 tail 불가 → 내용 해시
//   `.jsonl` 헤더 + 메시지 + $set 패치가 뒤에만 붙는 증분 로그 → 바이트 tail
// `.endsWith('.json')` 은 `.jsonl` 을 잡지 않습니다 — 둘을 따로 적어야 합니다.
export function isGeminiSessionFile(name) {
  return name.endsWith('.json') || name.endsWith('.jsonl');
}

export function geminiFileStrategy(filePath) {
  return String(filePath).toLowerCase().endsWith('.jsonl') ? 'line' : 'snapshot';
}

export async function detectGeminiRoots(roots) {
  const checks = await Promise.all(roots.map(async (root) => {
    try { return (await fsp.stat(root)).isDirectory() ? root : null; } catch { return null; }
  }));
  return checks.filter(Boolean);
}

// `chats` 안쪽만 봅니다.
//
// 형제 디렉터리인 `tool-outputs` 는 읽지 않습니다 — 실측 7,570개 파일에 토큰
// 키가 하나도 없었고(합계 0), 내용은 도구 출력 본문이라 열어서도 안 됩니다.
// 같은 프로젝트의 `logs.json` 에는 사용자 프롬프트 원문이 들어 있어 역시
// 열지 않고, 홈의 `oauth_creds.json` 도 이 어댑터가 여는 경로에 없습니다.
export async function discoverGeminiSessions(root) {
  const files = [];
  let projects;
  try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch { return files; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    await collectSessionFiles(path.join(root, project.name, 'chats'), files, 0);
  }
  return files.sort();
}

// `chats` 바로 아래만 보면 안 됩니다 — 세션 파일이 `chats/<uuid>/<이름>.json`
// 처럼 한 단계 더 들어가 있는 경우가 실재합니다. 실측에서 그런 파일이 2개
// 있었고 101,614 토큰이 담겨 있었습니다. ccusage 대조에서 우리 합계가 정확히
// 그만큼 모자라 드러났습니다 — 파일 이름도 `session-*` 가 아니라 임의 문자열
// (`gxblmq.json`)이라 이름 규칙으로도 못 찾습니다.
//
// 깊이는 2 까지만 내려갑니다. 관측된 배치는 한 단계뿐이고, 더 파면 도구가
// 나중에 `chats` 안에 만들 다른 산출물까지 세션으로 오해할 위험이 커집니다.
async function collectSessionFiles(dir, out, depth) {
  if (depth > 2) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSessionFiles(full, out, depth + 1);
    else if (entry.isFile() && isGeminiSessionFile(entry.name)) out.push(full);
  }
}

// `.../tmp/<이 이름>/chats/session-....json` 에서 가운데 조각을 뽑습니다.
export function geminiProjectDirName(filePath, root) {
  if (!root) return null;
  const relative = path.relative(root, String(filePath));
  if (!relative || relative.startsWith('..')) return null;
  const [first] = relative.split(/[\\/]+/);
  return first || null;
}

export const HASHED_PROJECT_DIR = /^[0-9a-f]{64}$/i;

// 홈의 projects.json 은 `{ projects: { "<소문자 절대경로>": "<슬러그>" } }` 입니다.
// 이것이 프로젝트 디렉터리 이름을 실제 경로로 되돌리는 유일한 공식 단서입니다.
//
// 실측(이 저장소 개발 머신, 프로젝트 디렉터리 186개):
//   - 슬러그형 76개 중 73개가 이 파일로 경로까지 풀립니다. 한 슬러그가 두
//     경로를 가리키는 경우는 0건이었습니다.
//   - 64자 해시형 110개 중 sha256(경로) 로 맞는 것은 2개뿐입니다. 옛 CLI 가
//     만든 해시이고 그 경로가 이 색인에 더 이상 없기 때문으로 보입니다 —
//     그래서 해시는 **일반적으로 역매핑 불가**로 다룹니다.
export async function readGeminiProjectIndex(home) {
  const bySlug = new Map();
  const byPathHash = new Map();
  let raw;
  try {
    raw = await fsp.readFile(path.join(home, 'projects.json'), 'utf8');
  } catch {
    return { bySlug, byPathHash };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { bySlug, byPathHash }; }
  const projects = parsed?.projects;
  if (!projects || typeof projects !== 'object') return { bySlug, byPathHash };

  for (const [projectPath, slug] of Object.entries(projects)) {
    if (typeof projectPath !== 'string' || typeof slug !== 'string') continue;
    // 같은 슬러그가 두 경로를 가리키면 어느 쪽인지 알 수 없습니다. 하나를
    // 골라 붙이면 남의 프로젝트 경로를 표시하게 되므로 그 슬러그를 버립니다.
    if (bySlug.has(slug)) bySlug.set(slug, null);
    else bySlug.set(slug, projectPath);
    for (const candidate of [projectPath, projectPath.toLowerCase()]) {
      byPathHash.set(crypto.createHash('sha256').update(candidate).digest('hex'), projectPath);
    }
  }
  return { bySlug, byPathHash };
}

// 디렉터리 이름 → { cwd, projectName } 해석.
//   1) 해시형이고 색인에서 sha256 이 맞으면 그 경로
//   2) 슬러그형이고 색인에 있으면 그 경로
//   3) 슬러그형인데 색인에 없으면 경로는 모르고 **이름은 슬러그가 사실**
//   4) 해시형이고 못 풀리면 경로도 이름도 모릅니다. 이때 'unknown-project' 로
//      접으면 서로 다른 프로젝트 81개가 한 줄로 합쳐지므로, 디렉터리 이름
//      앞부분을 그대로 식별자로 씁니다. 'gemini:' 접두사는 경로 구분자로
//      쓸 수 없는 문자라 폴더 이름으로 오해되지 않습니다.
export function resolveGeminiProject(dirName, index) {
  if (!dirName) return { cwd: null, projectName: null, resolved: false };
  const hashed = HASHED_PROJECT_DIR.test(dirName);
  if (hashed) {
    const byHash = index?.byPathHash?.get(dirName.toLowerCase()) ?? null;
    if (byHash) return { cwd: byHash, projectName: null, resolved: true };
    return { cwd: null, projectName: `gemini:${dirName.slice(0, 12)}`, resolved: false };
  }
  const bySlug = index?.bySlug?.get(dirName);
  if (bySlug) return { cwd: bySlug, projectName: null, resolved: true };
  return { cwd: null, projectName: dirName, resolved: false };
}

// 파일을 통째로 읽고 내용 해시를 같이 냅니다. 해시가 저장된 것과 같으면
// JSON.parse 와 적재를 건너뜁니다 — 세션 파일은 매번 다시 써지므로 mtime 만
// 보고는 "내용이 그대로인 재작성"을 걸러낼 수 없고, 파싱이 이 어댑터에서
// 가장 비싼 단계입니다.
export async function readGeminiSessionFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  return {
    text: buffer.toString('utf8'),
    contentHash: crypto.createHash('sha256').update(buffer).digest('hex'),
    byteLength: buffer.length,
  };
}

// Gemini 의 세션 식별자를 **파일 경로에서** 만듭니다.
//
// 로그의 `sessionId` 를 쓸 수 없다는 것을 실측으로 확인했습니다: 고유 값 377개
// 중 67개가 여러 파일에 걸쳐 있고, 그중 하나(`a2a-server` — UUID 도 아닙니다)는
// **파일 347개**가 공유합니다. `turns` 의 키가 (provider, session_id, turn_index)
// 이므로 세션이 유일하지 않으면 파일들이 턴 1,2,3… 을 서로 덮어쓰고,
// resetTurns 는 형제 파일의 턴 원장까지 지웁니다.
//
// Gemini 의 실제 대화 단위는 파일 하나입니다(`.json` 은 대화 한 건의 문서,
// `.jsonl` 은 대화 한 건의 로그). 그래서 경로를 세션 정체로 씁니다. 경로를
// 그대로 쓰지 않고 해시하는 이유는 세션 id 가 URL 에 실리기 때문입니다
// (projectKeyOf 와 같은 이유 — docs/dev/menus/project.md).
export function geminiSessionKey(filePath, root) {
  const relative = root ? path.relative(root, String(filePath)) : String(filePath);
  const normalized = relative.split(path.sep).join('/');
  return `gemini-${crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16)}`;
}
