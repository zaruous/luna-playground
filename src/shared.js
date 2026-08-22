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

// 냥코멘트 문구는 여기 없습니다. 서버가 주인이고(service/cat-comments.mjs)
// 화면은 GET /api/v1/comments 로 받아 그중 하나를 고릅니다 — 표를 양쪽에 두면
// 한쪽만 고쳤을 때 조용히 갈라집니다.
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

// 기간 합계 패널 문구. JSX 가 아니라 여기 두어 node:test 로 고정합니다.
export const PERIOD_BREAKDOWN_NOTICES = Object.freeze({
  mergedProviders:
    '입력 범주 정의가 provider마다 달라, 전체를 다섯 칸으로 합치면 조각 합이 맞지 않습니다. 아래는 provider별로 나눈 값입니다.',
  singleUndecomposable:
    '이 기간에는 토큰 범주가 겹치는지 판단할 수 없어 원래 범주를 그대로 표시합니다 — 조각 합이 합계와 다를 수 있습니다.',
});

export function sumTokenFields(rows = []) {
  const totals = { totalTokens: 0 };
  for (const category of tokenCategories) totals[category.key] = 0;
  for (const row of rows) {
    const tokens = row?.tokens ?? row;
    for (const key of Object.keys(totals)) totals[key] += Number(tokens?.[key]) || 0;
  }
  return totals;
}

export function buildProviderTokenSplits(providers = [], tokensByProvider) {
  const lookup = tokensByProvider instanceof Map
    ? tokensByProvider
    : new Map(Object.entries(tokensByProvider ?? {}));
  return providers
    .map((provider) => {
      const tokens = lookup.get(provider.id) ?? null;
      const totalTokens = Number(tokens?.totalTokens) || 0;
      if (totalTokens <= 0) return null;
      return {
        id: provider.id,
        name: provider.name,
        accounting: accountingLabels[provider.tokenAccounting] ?? '회계 미확인',
        ...decomposeTokens(tokens),
      };
    })
    .filter(Boolean);
}

export function resolvePeriodBreakdown({
  providerFilter = 'all',
  splits = [],
  mergedDecomposed,
  totalTokens = 0,
}) {
  const activeSplits = splits.filter((split) => (Number(split?.sum) || 0) > 0);
  if (providerFilter !== 'all' || activeSplits.length <= 1) {
    const periodTotal = Number(totalTokens) || 0;
    const notice = mergedDecomposed?.nested === false && periodTotal > 0
      ? PERIOD_BREAKDOWN_NOTICES.singleUndecomposable
      : null;
    return { layout: 'categories', categories: mergedDecomposed, notice };
  }
  return {
    layout: 'providers',
    categories: null,
    notice: PERIOD_BREAKDOWN_NOTICES.mergedProviders,
  };
}

function mergeDecomposedSegment(target, segment) {
  if (!segment?.value) return;
  const existing = target.get(segment.key);
  if (existing) existing.value += segment.value;
  else target.set(segment.key, { ...segment });
}

// 차트는 (b): UsageView 가 provider별로 이미 분해한 조각을 넘깁니다. 버킷마다
// provider 를 각자 decomposeTokens 한 뒤 nested 조각만 쌓고, y축·막대 높이는
// totalTokens(원장 합)만 씁니다 — fallback sum 으로 max 를 잡으면 1.98배까지
// 부풀었던 실측 결함이 그대로 돌아옵니다. nested:false 슬라이스는 조각을
// 억지로 쌓지 않고 remainder 로 남깁니다(R4).
export function buildChartColumns(bucketRows = []) {
  const grouped = new Map();
  for (const row of bucketRows) {
    const bucketStart = row.bucketStart;
    if (!grouped.has(bucketStart)) grouped.set(bucketStart, []);
    grouped.get(bucketStart).push(row);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucketStart, rows]) => {
      const totalTokens = rows.reduce((sum, row) => sum + (Number(row.tokens?.totalTokens) || 0), 0);
      const segmentMap = new Map();
      const extraMap = new Map();
      let hasUndecomposable = false;

      for (const row of rows) {
        const rowTotal = Number(row.tokens?.totalTokens) || 0;
        if (rowTotal <= 0) continue;
        const decomposed = decomposeTokens(row.tokens);
        if (decomposed.nested) {
          for (const segment of decomposed.segments) mergeDecomposedSegment(segmentMap, segment);
          for (const extra of decomposed.extras ?? []) mergeDecomposedSegment(extraMap, extra);
        } else {
          hasUndecomposable = true;
        }
      }

      const segments = [...segmentMap.values()];
      const extras = [...extraMap.values()];
      const stackedInsideTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
      const remainder = Math.max(0, totalTokens - stackedInsideTotal);

      return {
        bucketStart,
        totalTokens,
        segments,
        extras,
        remainder,
        nested: !hasUndecomposable,
        approximate: hasUndecomposable,
      };
    });
}

// hook 설치 상태를 당길 provider 목록. DashboardView·BudgetView 와 같은
// 기준(capabilities.hooks)을 씁니다 — id 배열을 App.jsx 에 하드코딩하면
// 새 hook provider 가 화면엔 보이는데 상태는 영원히 미확인으로 남습니다(E-1).
export function hookProviderIds(snapshot) {
  const providers = snapshot?.providers;
  if (!Array.isArray(providers) || !providers.length) return [];
  return providers.filter((item) => item.capabilities?.hooks).map((item) => item.id);
}

// Gemini 는 옛 CLI chats 와 agy(Antigravity CLI) SQLite 를 둘 다 봅니다.
// integration=connected 인데 detected=false·0 토큰이면 "안 썼다"로 읽히므로(R7)
// 원본 종류별로 화면 문구를 갈라야 합니다.
export function geminiSourceState(provider) {
  if (!provider || provider.id !== 'gemini') return null;
  const sources = provider.collector?.sources ?? {};
  const legacy = sources.legacyChats ?? { present: false, files: 0 };
  const agy = sources.antigravity ?? { present: false, conversations: 0 };
  const legacyPresent = Boolean(legacy.present);
  const agyPresent = Boolean(agy.present);
  const allTimeTokens = Number(provider.allTimeTotals?.totalTokens) || 0;
  const eventCount = Number(provider.allTimeTotals?.eventCount) || 0;
  const hasLedger = eventCount > 0 || allTimeTokens > 0;

  if (!legacyPresent && !agyPresent) {
    if (hasLedger) {
      return {
        kind: 'legacy-gone',
        label: '원본 로그 없음 — 원장 기록만',
        detail: '예전 Gemini CLI 세션 파일 경로가 사라졌습니다. 원장에 남은 합계만 표시할 수 있습니다.',
      };
    }
    return {
      kind: 'not-installed',
      label: '미설치',
      detail: 'Gemini CLI · Antigravity CLI 로그를 찾지 못했습니다.',
    };
  }

  if (agyPresent && !hasLedger && !legacyPresent) {
    return {
      kind: 'agy-unmeasured',
      label: 'agy 사용 중 · 토큰 회계 미확립',
      detail: 'Antigravity CLI 는 SQLite protobuf 에 사용량을 남깁니다. 필드 의미를 아직 확정하지 못해 수치를 표시하지 않습니다.',
    };
  }

  if (!legacyPresent && hasLedger) {
    return {
      kind: 'legacy-gone',
      label: '원본 로그 없음 — 원장 기록만',
      detail: '예전 Gemini CLI 세션 파일 경로가 사라졌습니다. 원장에 남은 합계만 표시할 수 있습니다.',
    };
  }

  if (legacyPresent && hasLedger) {
    return { kind: 'legacy-observed', label: null, detail: null };
  }

  if (agyPresent && !hasLedger) {
    return {
      kind: 'agy-unmeasured',
      label: 'agy 사용 중 · 토큰 회계 미확립',
      detail: 'Antigravity CLI 는 SQLite protobuf 에 사용량을 남깁니다. 필드 의미를 아직 확정하지 못해 수치를 표시하지 않습니다.',
    };
  }

  return { kind: 'legacy-observed', label: null, detail: null };
}

export function geminiTokensBlocked(provider) {
  const state = geminiSourceState(provider);
  return Boolean(state && state.kind !== 'legacy-observed');
}

export function geminiProviderActivityLabel(provider, options) {
  const state = geminiSourceState(provider);
  if (state && state.kind !== 'legacy-observed') return state.label;
  return providerActivityLabel(options);
}

export function connectionState({ error = null } = {}) {
  if (!error) {
    return { kind: 'live', message: null };
  }
  const status = error?.status;
  if (status === 401) {
    return {
      kind: 'stale-auth',
      message: '서비스가 다시 시작됐어요. 새로고침하면 이어집니다.',
    };
  }
  return {
    kind: 'unreachable',
    message: '서비스에 연결하지 못했어요. 서비스가 켜져 있는지 확인한 뒤 새로고침해 보세요.',
  };
}

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
