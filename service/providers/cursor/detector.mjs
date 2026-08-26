import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Cursor 는 두 표면에 로컬 데이터를 남깁니다 — CLI(cursor-agent)와 IDE(Composer).
// 문서: docs/dev/cursor/measurements.md, docs/dev/cursor/decisions.md.
//
//   CLI  ~/.cursor/chats/<workspaceHash>/<chatId>/{meta.json,store.db}
//        meta.json 에 cwd/시각, store.db 의 blobs(id, data) 에 대화 청크.
//   IDE  <Cursor User>/globalStorage/state.vscdb 의
//        composerHeaders(컴포저 메타) · cursorDiskKV(대화 청크 blob, content-addressed)
//
// scripts/probe-cursor.mjs 의 경로 해석과 같은 관례(NYANG_* 오버라이드)를 그대로
// 따릅니다 — 탐사 스크립트와 정식 어댑터가 서로 다른 곳을 보면 실측이 무의미해집니다.

export function resolveCursorHome(env = process.env) {
  if (env.NYANG_CURSOR_HOME) return path.resolve(env.NYANG_CURSOR_HOME);
  return path.join(os.homedir(), '.cursor');
}

export function resolveCursorAppData(env = process.env) {
  if (env.NYANG_CURSOR_APPDATA) return path.resolve(env.NYANG_CURSOR_APPDATA);
  if (process.platform !== 'win32') return null;
  return path.join(env.APPDATA || os.homedir(), 'Cursor', 'User');
}

export function cursorIdeGlobalStorageDb(cursorAppData) {
  if (!cursorAppData) return null;
  return path.join(cursorAppData, 'globalStorage', 'state.vscdb');
}

// ~/.cursor/chats/<workspaceHash>/<chatId>/store.db 전부를 훑습니다.
// probe-cursor.mjs 의 collectChatDbPaths 를 그대로 이식 — 탐사에서 이미 실측
// 검증된 로직이라 새로 설계하지 않습니다.
export async function discoverCliChatDbs(cursorHome) {
  const chatsRoot = path.join(cursorHome, 'chats');
  const dbPaths = [];
  let workspaceDirs;
  try {
    workspaceDirs = (await fsp.readdir(chatsRoot, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return dbPaths;
  }
  for (const workspaceDir of workspaceDirs) {
    const workspacePath = path.join(chatsRoot, workspaceDir.name);
    let chatDirs;
    try {
      chatDirs = (await fsp.readdir(workspacePath, { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const chatDir of chatDirs) {
      const dbPath = path.join(workspacePath, chatDir.name, 'store.db');
      if (fs.existsSync(dbPath)) dbPaths.push(dbPath);
    }
  }
  return dbPaths.sort();
}

// CLI meta.json — cwd/시각만 봅니다. 토큰·모델 필드는 여기 없습니다
// (docs/dev/cursor/measurements.md).
export async function readCliChatMeta(chatDbPath) {
  const metaPath = path.join(path.dirname(chatDbPath), 'meta.json');
  let raw;
  try {
    raw = await fsp.readFile(metaPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return {
    cwd: typeof parsed?.cwd === 'string' ? parsed.cwd : null,
    createdAtMs: Number.isFinite(parsed?.createdAtMs) ? parsed.createdAtMs : null,
    updatedAtMs: Number.isFinite(parsed?.updatedAtMs) ? parsed.updatedAtMs : null,
  };
}

// chatId 는 store.db 의 부모 디렉터리 이름입니다 — CLI 쪽 composer_id 로 씁니다.
export function cliChatId(chatDbPath) {
  return path.basename(path.dirname(chatDbPath));
}

// IDE 의 프로젝트 귀속. workspaceIdentifier.configPath.fsPath 를 우선하고,
// 없으면 trackedGitRepos 의 첫 저장소 경로로 대체합니다 — 둘 다 없으면 null
// (지어내지 않습니다, R7).
export function resolveIdeCwd(headerValue) {
  const fsPath = headerValue?.workspaceIdentifier?.configPath?.fsPath;
  if (typeof fsPath === 'string' && fsPath) return fsPath;
  const repoPath = headerValue?.trackedGitRepos?.[0]?.repoPath;
  if (typeof repoPath === 'string' && repoPath) return repoPath;
  return null;
}
