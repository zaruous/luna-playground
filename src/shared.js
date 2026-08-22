// 초기화는 되돌릴 수 없으므로 사용자가 이 문자열을 그대로 입력해야 합니다.
// 서버(service/api-server.mjs)도 같은 값을 요구하니, 한쪽만 바꾸면 초기화가
// 조용히 400 으로 거절됩니다 — 값을 여기 한 곳에 두고 양쪽이 봅니다.
export const RESET_CONFIRMATION = 'RESET';

// 파일 크기 표기. 토큰 표기(formatTokens)와 달리 1024 단위입니다 — 파일
// 탐색기에 보이는 수와 같아야 사용자가 대조할 수 있습니다.
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) { scaled /= 1024; unit += 1; }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

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
  { id: 'gemini', name: 'Gemini', short: 'G', tone: 'mint', status: '연동됨' },
];

// 어댑터가 아직 없는 provider 만 남습니다. Gemini 는 M5 에서 붙었으므로 여기서
// 빠집니다 — 남겨 두면 연동된 provider 에 "준비 중" 이 붙습니다.
export const providerMilestones = { cursor: 'M6' };

export function formatTokens(value = 0) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(number >= 10_000_000_000 ? 1 : 2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return number.toLocaleString('ko-KR');
}

export function formatPercent(value, digits = 0) {
  // null 을 따로 거릅니다. Number(null) 은 0 이라 Number.isFinite 를 통과하고,
  // 그러면 "아직 못 잰 값"이 자신만만한 0% 로 찍힙니다(R7).
  if (value === null || !Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

export const PENDING_LABEL = '로딩중..';

// 숫자 자리에는 세 가지 서로 다른 사실이 옵니다.
//   1) 아직 서버에서 값이 안 왔다        → '로딩중..'
//   2) 관측한 적이 없다                  → '—'
//   3) 관측했고 그 값이 0 이다           → '0'
// 셋을 같은 글자로 적으면 화면이 없는 사실을 말합니다. 특히 첫 스캔 중의 1) 을
// 3) 으로 적는 것이 가장 나쁩니다 — "이번 달 0 토큰" 은 사용자가 바로 자기
// 사용량으로 읽는 문장이기 때문입니다(R7).
export function measurementPending(snapshot) {
  if (!snapshot) return true;
  // 스캔이 끝났으면 0 은 진짜 0 입니다. 더 이상 기다릴 값이 없습니다.
  if (snapshot.warmup?.phase !== 'scanning') return false;
  // 스캔 중이라도 이미 들어온 값이 있으면 그건 부분값이지 미도착이 아닙니다.
  // 부분값이라는 사실은 상단 띠가 따로 말합니다.
  return (Number(snapshot.totals?.eventCount) || 0) === 0;
}

export function tokensText(value, pending = false) {
  return pending ? PENDING_LABEL : formatTokens(value);
}

export function percentText(value, pending = false, digits = 0) {
  return pending ? PENDING_LABEL : formatPercent(value, digits);
}

// 관측값이 없을 때 '—' 로 떨어지는 자리용. 스캔 중이면 '—' 대신 로딩 표시입니다.
export function tokensOrDash(value, pending = false) {
  if (pending) return PENDING_LABEL;
  return Number(value) ? formatTokens(value) : '—';
}

// provider 행의 상태 문구. "값이 0" 은 여러 가지 서로 다른 사실일 수 있고,
// 그것들을 한 문구로 합치면 화면이 없는 사실을 말합니다(R7).
//
//   1) 첫 스캔이 아직 이 provider 에 닿지 않았다   → 측정값 대기
//   2) 이 기간 관측이 있고 등급도 있다              → 품질 배지
//   3) 이 기간 관측이 있지만 등급이 없다            → 등급 없음
//   4) 관측한 적은 있는데 이 기간 활동이 없다       → 이번 달 기록 없음 (+ 전체 기간)
//   5) 한 번도 관측된 적이 없다                     → 관측 대기
//   6) 어댑터 자체가 없다                           → 카탈로그 상태(준비 중)
//
// 4) 가 없으면 원장에 수억 토큰이 있는 provider 에게 "관측 대기" 라고 말하게
// 됩니다 — Gemini 어댑터를 붙이고 실제로 그랬습니다.
// 3) 이 없으면 그 반대로, 값이 멀쩡히 찍혀 있는 행에 "관측 대기" 를 적게
// 됩니다 — 대시보드에 기간 칩을 붙이고 실제로 그랬습니다. 품질 등급은 이번 달
// 창으로만 계산되므로 다른 기간에서는 등급이 아예 없습니다.
export function providerActivityLabel({
  pending = false,
  badgeLabel = null,
  periodTokens = 0,
  allTimeTokens = 0,
  measurement = null,
  status = null,
  gradeUnavailable = false,
} = {}) {
  // 숫자 자리는 PENDING_LABEL('로딩중..')을 쓰지만, 이 자리는 상태 문구라
  // 무엇을 기다리는지 적습니다.
  if (pending) return '측정값 대기';
  if (badgeLabel) return badgeLabel;
  if (gradeUnavailable && Number(periodTokens) > 0) return '등급 없음';
  if (!Number(periodTokens) && Number(allTimeTokens) > 0) {
    return `이번 달 기록 없음 · 전체 ${formatTokens(allTimeTokens)}`;
  }
  if (measurement) return '관측 대기';
  return status ?? '관측 대기';
}

// 분모는 반드시 totals.promptTokens 입니다 — 엔진이 provider 회계에 맞춰 미리
// 계산해 내려주는 값입니다(service/providers/accounting.mjs promptSideTokens).
// cachedInputTokens / inputTokens 로 되돌리면 캐시가 input 밖에 있는 회계
// (Claude: input 10, cached 9000)에서 90000% 가 나옵니다.
// 잰 게 없으면 0% 가 아니라 null 입니다 — 0% 는 "캐시를 하나도 못 맞췄다"는
// 다른 사실입니다(R7).
export function cacheHitPercent(totals) {
  const prompt = Number(totals?.promptTokens) || 0;
  if (prompt <= 0) return null;
  return ((Number(totals?.cachedInputTokens) || 0) / prompt) * 100;
}

// 76% 와 95% 를 나란히 놓으면 같은 종류의 숫자로 읽힙니다. 어떤 회계로 잰
// 값인지 함께 적어야 그 비교가 거짓말이 되지 않습니다. 분기 기준은 언제나
// provider.tokenAccounting 이고 provider.id 가 아닙니다 — id 로 나누면 회계 표가
// 늘어날 때 화면만 조용히 옛 값을 붙잡습니다.
export const accountingLabels = {
  cache_in_input: '캐시 input 포함',
  cache_disjoint: '캐시 input 분리',
};

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

export function providerQuotaWindows(provider) {
  if (provider?.quotaWindows?.length) return provider.quotaWindows;
  return [provider?.rateLimits?.primary, provider?.rateLimits?.secondary].filter(Boolean);
}

// 서버 한도는 세 가지가 아니라 네 가지 상태입니다. capabilities 가 null 인
// provider(어댑터가 아직 없는 cursor)는 "한도가 없다"가 아니라 "아직 모른다"
// 입니다 — !provider.capabilities?.serverQuota 한 줄로 합치면 한 번도
// 관측한 적 없는 provider 에 '한도 미제공' 이라는 사실을 지어내게 됩니다(R7).
// reconciliation.status 로는 구분할 수 없습니다: snapshot 이 아직 없는 Codex 와
// 서버 원장 자체가 없는 Claude 가 둘 다 NO_SERVER_DATA 입니다(service/engine.mjs).
export function serverQuotaState(provider) {
  if (!provider?.capabilities) return { state: 'planned', label: '미연결' };
  if (!provider.capabilities.serverQuota) return { state: 'none', label: '한도 미제공' };
  if (!providerQuotaWindows(provider).length) return { state: 'waiting', label: 'snapshot 대기' };
  return { state: 'observed', label: null };
}

// limitId 는 store 가 provider id 를 소문자로 정규화해 넣은 값입니다
// (service/store.mjs normalizeLimitId + insertRateLimits). 'codex' 리터럴로 두면
// 두 번째 서버 원장 provider 가 붙는 순간 조용히 남의 창을 고릅니다.
export function featuredQuotaWindow(provider) {
  const windows = providerQuotaWindows(provider);
  return windows.find((window) => window.windowMinutes === 300 && window.limitId === provider?.id)
    ?? windows.find((window) => window.windowMinutes === 300)
    ?? windows[0]
    ?? null;
}

// 이 문구는 provider 한 곳의 대조 결과를 설명합니다 — 그러므로 이름을 인자로
// 받습니다. 'Codex' 리터럴을 두면 서버 원장을 가진 provider 가 둘이 되는 순간
// 남의 이름으로 남의 대조를 설명하게 됩니다. 이름을 못 받으면 지어내지 않고
// 문장에서 뺍니다(R7). 같은 이유로 'rollout 로그' 같은 Codex 전용 표현도 쓰지
// 않습니다 — Claude 가 남기는 것은 transcript 입니다.
export function reconcileCopy(reconciliation, providerName = null) {
  const owner = providerName ?? '연동된 provider';
  switch (reconciliation?.status) {
    case 'UNATTRIBUTED_SERVER_USAGE': return ['서버 사용량 차이가 보인다냥', `서버 한도는 움직였지만 이 PC의 로컬 ${owner} 로그에서 대응 사용량을 찾지 못한 구간이 있어요. 다른 기기·클라우드 작업·지연 정산 가능성을 분리해서 기록 중입니다.`];
    case 'LOCAL_AHEAD_OF_SERVER': return [`${owner} 로컬 로그가 먼저 달린다냥`, '로컬 토큰은 증가했지만 서버 한도 snapshot은 아직 움직이지 않은 구간이 있어요. 다음 서버 snapshot에서 다시 대조합니다.'];
    case 'SYNCED': return [`${owner} 로컬 기록과 서버 흐름이 잘 맞는다냥`, '토큰량은 로컬 로그 원본을 보존하고, 서버 사용률은 별도 snapshot으로 저장해 서로 억지로 보정하지 않고 비교합니다.'];
    // 서버 원장을 가진 provider 가 하나도 없으면 snapshot 은 영영 오지 않습니다.
    // "들어오면 대조합니다" 는 그때 지킬 수 없는 약속이라 문구를 갈라 둡니다.
    default: return providerName
      ? [`${providerName} 기록을 관측 중이다냥`, '토큰량은 provider의 로컬 로그 기준입니다. 서버 rate-limit snapshot이 들어오면 로컬 활동과 자동으로 대조합니다.']
      : ['로컬 기록만 보고 있다냥', '연결된 provider 중 서버 한도 원장을 주는 곳이 없어요. 지금 보이는 토큰은 전부 로컬 로그 관측값이고, 대조할 서버 값은 없습니다.'];
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

  // 추론이 출력 **밖**에 있는 회계(Gemini). 위 분기와 달리 output 에서
  // reasoning 을 빼면 안 됩니다 — 빼면 출력 조각이 실제보다 작아지고 합이
  // total 에 못 미칩니다. Codex 와 같은 cache_in_input 이라 캐시 읽기는
  // input 안쪽입니다(service/providers/gemini/parser.mjs 상단의 실측 근거).
  //
  // tool 을 이 항등식에 넣지 않는 이유: 실측 코퍼스에서 tool 이 전부 0 이어서
  // total 안인지 밖인지 확인할 수 없었습니다. 0 이 아닌 tool 이 나타나면 이
  // 분기가 안 맞고 아래 fallback 으로 떨어져 '겹침 미확인' 이 붙습니다 —
  // 모르는 것을 아는 척하지 않는 쪽이 맞습니다.
  // cacheWrite === 0 을 조건에 넣는 이유: Gemini 로그에는 캐시 쓰기 필드가
  // 아예 없어 항상 0 입니다. 이 조건이 없으면 캐시 쓰기가 있는 Claude 기록이
  // 우연히 이 항등식을 만족할 때 엉뚱한 분해가 먼저 잡힙니다.
  if (total > 0 && cacheWrite === 0 && reasoning > 0 && input >= cached
      && input + output + reasoning === total) {
    return {
      nested: true,
      sum: total,
      segments: [
        { key: 'cachedInputTokens', label: '캐시 읽기', tone: 'tk-cached', value: cached },
        { key: 'inputTokens', label: '비캐시 입력', tone: 'tk-input', value: input - cached },
        { key: 'outputTokens', label: '출력', tone: 'tk-output', value: output },
        { key: 'reasoningTokens', label: '추론', tone: 'tk-reason', value: reasoning },
      ],
      extras: [],
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
