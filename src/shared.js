export const catThemes = [
  { id: 'black', label: '블랙냥', hint: '차콜 · 크림 · 골드' },
  { id: 'white', label: '흰냥', hint: '아이보리 · 스카이블루' },
  { id: 'gray', label: '회색냥', hint: '스톤 · 세이지' },
  { id: 'orange', label: '주황냥', hint: '살구 · 테라코타' },
  { id: 'calico', label: '삼색냥', hint: '크림 · 먹색 · 오렌지' },
];

export const providerCatalog = [
  { id: 'codex', name: 'Codex', short: 'C', tone: 'violet', status: '연동됨' },
  { id: 'claude', name: 'Claude', short: 'Cl', tone: 'orange', status: '다음 단계' },
  { id: 'cursor', name: 'Cursor', short: 'Cu', tone: 'blue', status: '준비 중' },
  { id: 'gemini', name: 'Gemini', short: 'G', tone: 'mint', status: '준비 중' },
];

export const providerMilestones = { claude: 'M3', gemini: 'M5', cursor: 'M6' };

export function formatTokens(value = 0) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(number >= 10_000_000_000 ? 1 : 2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return number.toLocaleString('ko-KR');
}

export function formatPercent(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

export function relativeTime(value) {
  if (!value) return '기록 없음';
  const diff = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

export function windowLabel(window) {
  const minutes = window?.windowMinutes;
  if (minutes === 300) return '5시간 한도';
  if (minutes === 10080) return '주간 한도';
  if (minutes) return `${minutes}분 한도`;
  return '서버 한도';
}

export function quotaLabel(window) {
  const base = windowLabel(window);
  const name = window?.limitName;
  if (!name || /^codex$/i.test(name)) return base;
  return `${name} · ${base}`;
}

export function resetLabel(window) {
  if (!window?.resetsAt) return '리셋 시각 미확인';
  return `${new Date(window.resetsAt * 1000).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })} 리셋`;
}

export function reconcileCopy(reconciliation) {
  switch (reconciliation?.status) {
    case 'UNATTRIBUTED_SERVER_USAGE': return ['서버 사용량 차이가 보인다냥', '서버 한도는 움직였지만 이 PC의 로컬 Codex 로그에서 대응 사용량을 찾지 못한 구간이 있어요. 다른 기기·클라우드 작업·지연 정산 가능성을 분리해서 기록 중입니다.'];
    case 'LOCAL_AHEAD_OF_SERVER': return ['로컬 로그가 먼저 달린다냥', '로컬 토큰은 증가했지만 서버 한도 snapshot은 아직 움직이지 않은 구간이 있어요. 다음 서버 snapshot에서 다시 대조합니다.'];
    case 'SYNCED': return ['로컬 기록과 서버 흐름이 잘 맞는다냥', '토큰량은 로컬 로그 원본을 보존하고, 서버 사용률은 별도 snapshot으로 저장해 서로 억지로 보정하지 않고 비교합니다.'];
    default: return ['Codex 기록을 관측 중이다냥', '토큰량은 로컬 rollout 로그 기준입니다. 서버 rate-limit snapshot이 들어오면 로컬 활동과 자동으로 대조합니다.'];
  }
}

export const tokenCategories = [
  { key: 'inputTokens', label: '입력', tone: 'tk-input' },
  { key: 'cachedInputTokens', label: '캐시 읽기', tone: 'tk-cached' },
  { key: 'cacheWriteInputTokens', label: '캐시 쓰기', tone: 'tk-cachew' },
  { key: 'outputTokens', label: '출력', tone: 'tk-output' },
  { key: 'reasoningTokens', label: '추론', tone: 'tk-reason' },
];

// 누적 막대는 겹치지 않는 조각으로만 쌓아야 합니다. Codex(OpenAI) 회계에서
// cached·cacheWrite 는 input 안에, reasoning 은 output 안에 포함되므로 5개
// 범주를 그대로 쌓으면 합이 실제의 두 배 가까이 부풀어 규칙 R4를 어깁니다.
//
// 그래서 total === input + output 항등식이 성립할 때만 분해하고, 성립하지
// 않으면(다른 provider가 다른 회계를 쓰는 경우) 분해를 포기하고 원래 범주를
// 그대로 표시합니다. cacheWrite 가 input 에 포함되는지는 실제 Codex 로그로
// 아직 검증하지 못했고, 항등식 검사가 그 가정이 깨지는 순간을 잡아냅니다.
export function decomposeTokens(tokens = {}) {
  const value = (key) => Number(tokens[key]) || 0;
  const input = value('inputTokens');
  const cached = value('cachedInputTokens');
  const cacheWrite = value('cacheWriteInputTokens');
  const output = value('outputTokens');
  const reasoning = value('reasoningTokens');
  const total = value('totalTokens');
  const uncachedInput = input - cached - cacheWrite;

  if (total > 0 && input + output === total && uncachedInput >= 0 && output >= reasoning) {
    return {
      nested: true,
      sum: total,
      segments: [
        { key: 'cachedInputTokens', label: '캐시 읽기', tone: 'tk-cached', value: cached },
        { key: 'cacheWriteInputTokens', label: '캐시 쓰기', tone: 'tk-cachew', value: cacheWrite },
        { key: 'inputTokens', label: '비캐시 입력', tone: 'tk-input', value: uncachedInput },
        { key: 'outputTokens', label: '출력', tone: 'tk-output', value: output - reasoning },
        { key: 'reasoningTokens', label: '추론', tone: 'tk-reason', value: reasoning },
      ],
    };
  }

  const segments = tokenCategories.map((category) => ({
    key: category.key,
    label: category.label,
    tone: category.tone,
    value: value(category.key),
  }));
  return { nested: false, sum: segments.reduce((acc, segment) => acc + segment.value, 0), segments };
}
