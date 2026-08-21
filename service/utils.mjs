import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

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

// 로그를 쓴 기계와 읽는 기계의 OS가 다를 수 있습니다 — 예를 들어 WSL에서
// Windows Codex 로그를 읽으면 cwd 는 'C:\\Users\\...' 인데 호스트의 path 는
// POSIX 라 basename 이 백슬래시를 구분자로 보지 않습니다. cwd 는 우리 파일
// 시스템의 경로가 아니라 로그에 적힌 데이터이므로 두 구분자를 모두 처리합니다.
export function projectNameFromCwd(cwd) {
  if (!cwd) return 'unknown-project';
  const trimmed = String(cwd).trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'unknown-project';
  const segments = trimmed.split(/[\\/]+/).filter((segment) => segment && segment !== '.');
  const last = segments[segments.length - 1];
  // 드라이브 문자만 남으면(예: 'C:') 이름으로 쓰지 않고 원본을 유지합니다.
  if (!last || /^[a-zA-Z]:$/.test(last)) return trimmed;
  return last;
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

// 프로젝트 식별자는 경로가 아니라 해시입니다. 원본 경로를 URL에 넣으면
// 서버 로그와 브라우저 히스토리에 남기 때문입니다(docs/dev/menus/project.md).
export function projectKeyOf(provider, projectName) {
  return crypto.createHash('sha1').update(`${provider}|${projectName ?? ''}`).digest('hex').slice(0, 16);
}

// 토큰 측정 품질 등급 사다리. 이벤트 전역 등급은 필드 중 최저치를
// 따릅니다(docs/dev/provider-token-api.md §4).
export const MEASUREMENT_QUALITY_ORDER = Object.freeze(['unverified', 'partial', 'local_exact', 'server_verified']);

export function worstQuality(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  const leftRank = MEASUREMENT_QUALITY_ORDER.indexOf(left);
  const rightRank = MEASUREMENT_QUALITY_ORDER.indexOf(right);
  if (leftRank < 0) return right;
  if (rightRank < 0) return left;
  return leftRank <= rightRank ? left : right;
}
