export const catThemes = [
  { id: 'black', label: '블랙냥', hint: '차콜 · 크림 · 골드' },
  { id: 'white', label: '흰냥', hint: '아이보리 · 스카이블루' },
  { id: 'gray', label: '회색냥', hint: '스톤 · 세이지' },
  { id: 'orange', label: '주황냥', hint: '살구 · 테라코타' },
  { id: 'calico', label: '삼색냥', hint: '크림 · 먹색 · 오렌지' },
];

export const providerCatalog = [
  { id: 'codex', name: 'Codex', short: 'C', tone: 'violet', status: '연동됨' },
  { id: 'claude', name: 'Claude', short: 'Cl', tone: 'orange', status: '연동됨' },
  { id: 'cursor', name: 'Cursor', short: 'Cu', tone: 'blue', status: '준비 중' },
  { id: 'gemini', name: 'Gemini', short: 'G', tone: 'mint', status: '준비 중' },
];

export const providerMilestones = { gemini: 'M5', cursor: 'M6' };

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

// 품질 등급은 UI 장식이 아니라 데이터입니다(docs/dev/provider-token-api.md §4).
// 라벨은 그 문서의 표를 그대로 씁니다.
export const qualityLabels = {
  server_verified: { label: '서버 검증됨', tone: 'server' },
  local_exact: { label: '로컬 관측', tone: 'local' },
  partial: { label: '추정', tone: 'partial' },
  unverified: { label: '미확인', tone: 'unverified' },
};

const fieldLabels = {
  inputTokens: '비캐시 입력',
  cachedInputTokens: '캐시 읽기',
  cacheWriteInputTokens: '캐시 쓰기',
  outputTokens: '출력',
  reasoningTokens: '추론',
  toolTokens: '도구',
};

export function qualityBadge(quality) {
  const grade = quality?.overall ?? null;
  return { grade, ...(qualityLabels[grade] ?? { label: '관측 대기', tone: 'wait' }) };
}

// 필드 단위 근거를 한 줄로 풉니다. 이벤트 한 건 때문에 필드 전체가 "추정"으로
// 보이는 것을 막기 위해, 등급별 건수가 갈리면 다수 등급과 소수 건수를 함께
// 적습니다.
export function qualityFieldSummary(quality) {
  const fields = quality?.fields ?? {};
  return Object.entries(fields).map(([field, detail]) => {
    const counts = detail?.counts ?? {};
    const ranked = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    const [dominantGrade, dominantCount] = ranked[0] ?? [detail?.worst, 0];
    const rest = ranked.slice(1);
    const restText = rest.length
      ? ` (${rest.map(([grade, count]) => `${qualityLabels[grade]?.label ?? grade} ${count.toLocaleString('ko-KR')}건`).join(', ')})`
      : '';
    return {
      field,
      label: fieldLabels[field] ?? field,
      grade: dominantGrade,
      gradeLabel: qualityLabels[dominantGrade]?.label ?? dominantGrade,
      eventCount: dominantCount,
      text: `${fieldLabels[field] ?? field} ${qualityLabels[dominantGrade]?.label ?? dominantGrade}${restText}`,
    };
  });
}

// 여러 provider 총합의 등급은 가장 낮은 provider 를 따릅니다 — 합계에 "추정"이
// 섞였으면 합계는 추정입니다.
export function aggregateQuality(providers = []) {
  const grades = providers
    .filter((provider) => (provider?.totals?.totalTokens ?? 0) > 0)
    .map((provider) => provider?.quality?.overall)
    .filter(Boolean);
  if (!grades.length) return { grade: null, ...qualityLabels.local_exact, label: '관측 대기', tone: 'wait' };
  const order = ['unverified', 'partial', 'local_exact', 'server_verified'];
  const worst = grades.reduce((acc, grade) => (order.indexOf(grade) < order.indexOf(acc) ? grade : acc), grades[0]);
  return { grade: worst, ...qualityLabels[worst] };
}

// 작업 단계 라벨. 정규 단계는 service/providers/tool-phases.mjs 와 같은 6개뿐
// 입니다 — 늘리면 화면과 백엔드의 분류가 어긋납니다.
export const phaseLabels = {
  explore: '탐색',
  implement: '구현',
  verify: '검증',
  plan: '계획',
  clarify: '확인',
  delegate: '위임',
  other: '기타',
  'no-tool': '도구 없음',
};

export function phaseLabel(phase) {
  if (!phase) return '—';
  return phaseLabels[phase] ?? phase;
}

export const tokenCategories = [
  { key: 'inputTokens', label: '입력', tone: 'tk-input' },
  { key: 'cachedInputTokens', label: '캐시 읽기', tone: 'tk-cached' },
  { key: 'cacheWriteInputTokens', label: '캐시 쓰기', tone: 'tk-cachew' },
  { key: 'outputTokens', label: '출력', tone: 'tk-output' },
  { key: 'reasoningTokens', label: '추론', tone: 'tk-reason' },
];

// 누적 막대는 겹치지 않는 조각으로만 쌓아야 합니다(R4).
//
// provider 는 회계가 서로 다릅니다. 둘 다 ccusage 와의 대조로 확인했습니다
// (docs/토큰 사용량 측정.md 참고).
//
// Codex rollout:
//   input  = 비캐시 입력 + 캐시 읽기   ← cached 는 input 안에 포함
//   total  = input + output            ← 캐시 쓰기는 total 밖
//   output ⊇ reasoning
//
// Claude transcript:
//   input  = 비캐시 입력만             ← 캐시 읽기/쓰기는 input 밖
//   total  = input + 캐시 읽기 + 캐시 쓰기 + output
//   output ⊇ reasoning
//
// 어느 항등식이 성립하는지는 숫자를 보고 판단합니다 — provider id 로 분기하지
// 않습니다. 둘 다 안 맞으면 분해를 포기하고 원래 범주를 그대로 표시합니다.
export function decomposeTokens(tokens = {}) {
  const value = (key) => Number(tokens[key]) || 0;
  const input = value('inputTokens');
  const cached = value('cachedInputTokens');
  const cacheWrite = value('cacheWriteInputTokens');
  const output = value('outputTokens');
  const reasoning = value('reasoningTokens');
  const total = value('totalTokens');

  if (total > 0 && input + output === total && input >= cached && output >= reasoning) {
    return {
      nested: true,
      sum: total,
      segments: [
        { key: 'cachedInputTokens', label: '캐시 읽기', tone: 'tk-cached', value: cached },
        { key: 'inputTokens', label: '비캐시 입력', tone: 'tk-input', value: input - cached },
        { key: 'outputTokens', label: '출력', tone: 'tk-output', value: output - reasoning },
        { key: 'reasoningTokens', label: '추론', tone: 'tk-reason', value: reasoning },
      ],
      extras: cacheWrite > 0
        ? [{ key: 'cacheWriteInputTokens', label: '캐시 쓰기', tone: 'tk-cachew', value: cacheWrite, note: '합계 외' }]
        : [],
    };
  }

  // 캐시가 input 밖에 있는 회계(Claude). 캐시 쓰기가 합계 안에 들어오므로
  // extras 가 아니라 조각으로 쌓습니다.
  if (total > 0 && input + cached + cacheWrite + output === total && output >= reasoning) {
    return {
      nested: true,
      sum: total,
      segments: [
        { key: 'cachedInputTokens', label: '캐시 읽기', tone: 'tk-cached', value: cached },
        { key: 'cacheWriteInputTokens', label: '캐시 쓰기', tone: 'tk-cachew', value: cacheWrite },
        { key: 'inputTokens', label: '비캐시 입력', tone: 'tk-input', value: input },
        { key: 'outputTokens', label: '출력', tone: 'tk-output', value: output - reasoning },
        { key: 'reasoningTokens', label: '추론', tone: 'tk-reason', value: reasoning },
      ],
      extras: [],
    };
  }

  const segments = tokenCategories.map((category) => ({
    key: category.key,
    label: category.label,
    tone: category.tone,
    value: value(category.key),
  }));
  return { nested: false, sum: segments.reduce((acc, segment) => acc + segment.value, 0), segments, extras: [] };
}
