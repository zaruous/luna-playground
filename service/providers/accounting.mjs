// provider 별 토큰 회계 모델.
//
// 두 모델이 있고, 어느 쪽인지 모르면 파생값이 조용히 틀립니다.
//
//   cache_in_input   캐시 읽기가 input **안에** 있다 (Codex)
//                    프롬프트 = input + 캐시 쓰기
//                    total    = input + output
//
//   cache_disjoint   캐시 읽기가 input **밖에** 있다 (Claude, Anthropic API 회계)
//                    프롬프트 = input + 캐시 읽기 + 캐시 쓰기
//                    total    = 프롬프트 + output
//
// 표를 여기 한 곳에 두는 이유는 어댑터 capabilities·엔진 집계·스토어 쿼리가
// 같은 값을 봐야 하기 때문입니다. 예전에 이 값이 두 곳에 흩어져 있었고, 그때
// 캐시 적중률이 Claude 에서 수천 %로 나왔습니다.
export const TOKEN_ACCOUNTING = Object.freeze({
  codex: 'cache_in_input',
  claude: 'cache_disjoint',
  // Cursor Admin API 의 tokenUsage 도 캐시를 따로 줍니다(M6 에서 확인).
  cursor: 'cache_disjoint',
  // Gemini 가이드가 cached 를 input 에서 분리하라고 명시합니다(M5 에서 확인).
  gemini: 'cache_disjoint',
});

export const DEFAULT_TOKEN_ACCOUNTING = 'cache_disjoint';

export function accountingOf(provider) {
  return TOKEN_ACCOUNTING[String(provider).toLowerCase()] ?? DEFAULT_TOKEN_ACCOUNTING;
}

// 겹치지 않는 "프롬프트 쪽 토큰". 캐시 적중률의 분모이고, provider 간 합산이
// 가능합니다 — 각 provider 안에서 서로 겹치지 않게 만들었기 때문입니다.
export function promptSideTokens(provider, tokens) {
  const input = Number(tokens?.inputTokens) || 0;
  const cached = Number(tokens?.cachedInputTokens) || 0;
  const cacheWrite = Number(tokens?.cacheWriteInputTokens) || 0;
  return accountingOf(provider) === 'cache_disjoint'
    ? input + cached + cacheWrite
    : input + cacheWrite;
}

// "새로 만든 1토큰당 몇 토큰을 다시 읽었나". 근거가 없으면 null 입니다 —
// 0 으로 채우면 "재사용이 전혀 없었다"는 거짓이 됩니다(R7).
export function reuseMultiple(tokens) {
  const fresh = (Number(tokens?.inputTokens) || 0) + (Number(tokens?.outputTokens) || 0);
  if (fresh <= 0) return null;
  return (Number(tokens?.cachedInputTokens) || 0) / fresh;
}
