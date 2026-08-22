import { useEffect, useMemo, useState } from 'react';
import CatArt from '../CatArt.jsx';
// 회계 표는 한 곳에만 둡니다. 기간을 바꿔 timeseries 를 접어 쓸 때 스냅샷의
// promptTokens 가 없어 직접 계산해야 하는데, 규칙을 화면에 복제하면 그 표가
// 두 곳으로 갈라집니다(service/providers/accounting.mjs 주석 참고).
import { promptSideTokensFor } from '../../service/providers/accounting.mjs';
import { TableHead, sortRows, useTableSort, useSlowStamp } from './Bits.jsx';
import {
  providerCatalog, formatTokens, formatPercent, relativeTime,
  windowLabel, quotaLabel, resetLabel, reconcileCopy,
  aggregateQuality, qualityBadge, qualityFieldSummary,
  buildProviderTokenSplits, cacheHitPercent, accountingLabels, serverQuotaState, featuredQuotaWindow, providerQuotaWindows,
  decomposeTokens, PENDING_LABEL, percentText, providerActivityLabel, tokensOrDash, tokensText,
} from '../shared.js';

// 정렬 기준은 원본 값입니다 — 화면의 '4.60B' 를 사전순으로 세우면 319.6M 이
// 더 커집니다(Bits.jsx sortRows 주석 참고).
const PROJECT_COLUMNS = [
  { key: 'name', label: '프로젝트', type: 'text' },
  { key: 'provider', label: '주 사용 AI', type: 'text' },
  { key: 'totalTokens', label: '토큰 사용량', type: 'number' },
  { key: 'lastActivity', label: '마지막 활동', type: 'time' },
];

// snapshot 을 아직 못 받은 서버 원장 provider 에만 쓰는 자리표시자입니다.
// serverQuota 가 false 인 provider 에 재사용하면 존재하지도 않는 5시간/주간
// 한도 창 두 개를 지어내게 됩니다.
const quotaPlaceholderRows = [
  { windowType:'primary', windowMinutes:300, unavailable:true },
  { windowType:'secondary', windowMinutes:10080, unavailable:true },
];

// 서버 한도 상태 문구 한 벌. 칩과 요약 카드가 같은 판단을 읽어야 화면이 스스로와
// 어긋나지 않습니다. featuredQuota 가 없다고 전부 '대기 중'으로 적으면, 서버
// 원장을 아예 남기지 않는 provider 만 붙어 있을 때 영영 오지 않을 측정을
// 약속하게 됩니다 — 바로 아래 split 줄의 '한도 미제공' 과 정면으로 어긋납니다(R7).
// 반대 방향 실수도 같이 막습니다: capabilities 를 아직 못 읽은 provider(planned)를
// none 으로 접으면 관측한 적 없는 '한도 미제공' 을 지어내게 됩니다. serverQuotaState
// 가 네 상태를 굳이 나눠 두는 이유이고, 여기서도 그 넷을 그대로 받습니다.
const serverLedgerCopy = {
  observed: { chip: '한도 snapshot', tone: 'server', label: '서버 관측', note: '관측 시각 미확인' },
  waiting: { chip: 'snapshot 대기', tone: 'server', label: '서버 관측', note: '대기 중' },
  none: { chip: '한도 미제공', tone: 'unverified', label: '한도 미제공', note: '서버 원장 없음' },
  planned: { chip: '한도 미확인', tone: 'unverified', label: '한도 미확인', note: '서버 원장 유무 미확인' },
  unknown: { chip: '연동 대기', tone: 'wait', label: '관측 대기', note: '연동된 provider 없음' },
};

// matched/server-only/local-only 세 개의 0 은 "대조했더니 같더라"가 아닙니다.
// 대조 행은 insertRateLimits 안의 reconcileLatestWindow 에서만 생기므로, 행이
// 없다는 것은 언제나 "아직 한 번도 비교하지 않았다" 입니다(service/store.mjs).
// 0 을 그대로 찍으면 관측한 적 없는 것을 관측 결과로 말하게 됩니다(R7).
function reconcileCounts(reconciliation) {
  if (!reconciliation?.recent?.length) return null;
  return `최근 대조: matched ${reconciliation.matched ?? 0} · server-only ${reconciliation.serverOnly ?? 0} · local-only ${reconciliation.localOnly ?? 0}`;
}

// 대시보드의 기간. 스냅샷은 이번 달 고정이고 SSE 로 실시간 갱신되므로 '이번 달'
// 은 스냅샷을 그대로 쓰고, 그 밖의 기간만 REST 로 당깁니다 — UsageView·SessionView
// 와 같은 분담입니다(SSE = 현재 상태, REST = 기간 데이터).
const PERIODS = [
  { id: 'month', label: '이번 달' },
  { id: 'all', label: '전체 기간' },
];

// 고른 기간은 다음 실행에도 기억합니다(스킨과 같은 방식).
const PERIOD_KEY = 'nyangtracker-dashboard-period';

function savedPeriod() {
  try {
    const saved = window.localStorage?.getItem(PERIOD_KEY);
    return PERIODS.some((item) => item.id === saved) ? saved : null;
  } catch {
    // 프라이빗 모드처럼 localStorage 를 못 쓰는 환경.
    return null;
  }
}

// 스냅샷이 주는 totals 와 같은 모양으로 timeseries 를 접습니다.
const TOKEN_KEYS = [
  'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
  'outputTokens', 'reasoningTokens', 'totalTokens', 'eventCount',
];

function emptyTokens() {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0]));
}

function addTokens(target, source) {
  for (const key of TOKEN_KEYS) target[key] += Number(source?.[key]) || 0;
  return target;
}

export default function DashboardView({ snapshot, hookStatuses, api, actionBusy, currentTheme, pending = false, onToggleHooks }) {
  const [period, setPeriodState] = useState(() => savedPeriod() ?? 'month');
  // 사용자가 직접 고른 적이 있는가. 없으면 아래 effect 가 스냅샷을 보고 한 번만
  // 기본값을 정합니다.
  const [periodChosen, setPeriodChosen] = useState(() => savedPeriod() !== null);
  const [periodSeries, setPeriodSeries] = useState(null);
  const [periodError, setPeriodError] = useState(null);

  const setPeriod = (next) => {
    setPeriodState(next);
    setPeriodChosen(true);
    try { window.localStorage?.setItem(PERIOD_KEY, next); } catch { /* 저장 못 해도 동작은 같습니다 */ }
  };
  // 스냅샷 시각을 그대로 의존성에 넣으면 SSE 가 밀어대는 동안 요청이 계속
  // 취소됩니다(Bits.jsx 의 useSlowStamp 주석 참고).
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);
  const monthScoped = period === 'month';

  // 사용자가 기간을 고른 적이 없을 때만, 스냅샷을 보고 첫 화면의 기간을 한 번
  // 정합니다. 원장에 기록이 있는데 **이번 달만** 비어 있는 provider 가 있으면
  // 전체 기간으로 엽니다 — 그렇지 않으면 9.8억 토큰을 가진 provider 가 첫
  // 화면에서 '—' 로 보이고, 사용자는 칩을 눌러야 그게 있다는 걸 압니다.
  //
  // 이건 "조용히 기준을 바꾸는 것"이 아닙니다. 고른 기간은 칩에 선택 표시로,
  // 카드 제목에 "전체 기간 총 토큰" 으로, 안내줄에 어느 블록이 이번 달로
  // 남는지까지 그대로 드러납니다. localStorage 에는 사용자가 직접 고른 값만
  // 씁니다 — 자동 판단을 저장하면 나중에 이번 달 기록이 생겨도 전체 기간에
  // 붙어 있게 됩니다.
  useEffect(() => {
    if (periodChosen || !snapshot?.providers?.length) return;
    const idleWithHistory = snapshot.providers.some((provider) => (
      provider.integration === 'connected'
      && (provider.allTimeTotals?.totalTokens ?? 0) > 0
      && (provider.totals?.totalTokens ?? 0) === 0
    ));
    setPeriodChosen(true);
    if (idleWithHistory) setPeriodState('all');
  }, [periodChosen, snapshot]);

  useEffect(() => {
    if (monthScoped || !api?.usage?.getTimeseries) { setPeriodSeries(null); return undefined; }
    let active = true;
    // 버킷은 월로 잡습니다 — 대시보드는 추이를 그리지 않고 합계만 쓰므로
    // 가장 적은 행으로 충분합니다(전체 기간에 월 버킷 17개).
    api.usage.getTimeseries({ all: 1, bucket: 'month' })
      .then((payload) => { if (active) { setPeriodSeries(payload?.series ?? []); setPeriodError(null); } })
      .catch((error) => { if (active) { setPeriodSeries([]); setPeriodError(error.message || '불러오지 못했습니다'); } });
    return () => { active = false; };
  }, [api, monthScoped, stamp]);

  // provider 별 기간 합계. 이번 달이면 스냅샷의 값을 그대로 씁니다.
  const periodByProvider = useMemo(() => {
    const map = new Map();
    if (monthScoped) {
      for (const provider of snapshot?.providers ?? []) map.set(provider.id, provider.totals ?? emptyTokens());
      return map;
    }
    for (const point of periodSeries ?? []) {
      addTokens(map.get(point.provider) ?? map.set(point.provider, emptyTokens()).get(point.provider), point.tokens);
    }
    // 회계별 프롬프트 분모를 붙입니다 — 캐시 적중률이 이 값을 씁니다.
    for (const provider of snapshot?.providers ?? []) {
      const tokens = map.get(provider.id);
      if (tokens) tokens.promptTokens = promptSideTokensFor(provider.tokenAccounting, tokens);
    }
    return map;
  }, [monthScoped, periodSeries, snapshot]);

  const totals = useMemo(() => {
    if (monthScoped) {
      return snapshot?.totals ?? { ...emptyTokens(), promptTokens: 0, cacheRate: 0 };
    }
    const sum = emptyTokens();
    let promptTokens = 0;
    for (const tokens of periodByProvider.values()) {
      addTokens(sum, tokens);
      promptTokens += Number(tokens.promptTokens) || 0;
    }
    // 프롬프트 분모는 provider 별로 회계를 반영해 만든 뒤 더합니다. 합계에
    // 회계를 한 번에 적용하면 회계가 다른 provider 가 섞여 뜻이 없어집니다.
    return { ...sum, promptTokens };
  }, [monthScoped, snapshot, periodByProvider]);

  const projects = snapshot?.projects ?? [];
  const [projectSort, toggleProjectSort] = useTableSort(PROJECT_COLUMNS, 'lastActivity');
  const sortedProjects = useMemo(() => sortRows(projects, PROJECT_COLUMNS, projectSort), [projects, projectSort]);
  const projectSortLabel = PROJECT_COLUMNS.find((column) => column.key === projectSort.key)?.label ?? '기본';

  const providerRows = useMemo(() => {
    const measuredProviders = snapshot?.providers?.length ? snapshot.providers : providerCatalog;
    return measuredProviders.map((measured) => {
      const provider = providerCatalog.find((item) => item.id === measured.id) ?? {
        id: measured.id, name: measured.name, short: measured.name?.slice(0, 2) ?? '?', tone: 'mint', status: '연동됨',
      };
      // 막대·비중·분해가 읽는 값은 **선택한 기간**입니다. 스냅샷의 totals 를
      // 그대로 쓰면 기간을 바꿨는데 이 패널만 이번 달을 말합니다.
      const periodTokens = periodByProvider.get(measured.id) ?? null;
      const tokens = periodTokens?.totalTokens ?? 0;
      const status = measured?.integration === 'connected' ? '연동됨' : provider.status;
      return {
        ...provider, ...measured, status, tokens, periodTokens,
        measurement: measured?.measurement ?? null,
        // 품질 등급은 이번 달 창으로만 계산됩니다(스냅샷의 quality). 다른 기간의
        // 합계에 이 배지를 붙이면 남의 기간의 사실을 말하게 되므로 붙이지 않습니다.
        badge: monthScoped && tokens ? qualityBadge(measured?.quality) : null,
      };
    });
  }, [snapshot, periodByProvider, monthScoped]);
  const maxTokens = Math.max(1, ...providerRows.map((item) => item.tokens));

  // 수집 상태 칩은 provider 하나가 아니라 지금 실제로 수집하는 provider 전체를
  // 가리켜야 합니다. Claude 가 붙은 뒤로 "Codex 발견"만 보여주면 거짓말입니다.
  const collectingProviders = providerRows.filter((item) => item.collector?.detected);
  const watchingProviders = providerRows.filter((item) => item.collector?.watching);
  const collectorDetected = collectingProviders.length > 0;
  const collectorWatching = watchingProviders.length > 0;
  const sumFiles = (rows) => rows.reduce((sum, item) => sum + (item.collector?.filesDiscovered ?? 0), 0);
  const watchedFileCount = sumFiles(watchingProviders);
  const discoveredFileCount = sumFiles(collectingProviders);
  // 서버 원장 이야기는 실제로 연동된 provider 에만 걸립니다. 웹 미리보기에서는
  // providerRows 가 providerCatalog 로 대체되는데 그 행에는 capabilities 도
  // quotaWindows 도 없으므로, integration 으로 거르면 유령 블록이 안 생깁니다.
  const ledgerRows = providerRows.filter((item) => item.integration === 'connected');
  // 분기는 reconciliation.status 가 아니라 capabilities 기준입니다. status 는
  // "snapshot 이 아직 없음"과 "서버 원장 자체가 없음"이 똑같이 NO_SERVER_DATA 라
  // 구분이 안 되고, 그러면 matched/server-only/local-only 세 개의 0 이 "대조했는데
  // 차이가 없다"로 읽힙니다 — 대조한 적이 없는 provider 에 대한 거짓말입니다.
  // 여기 오는 행은 이미 integration === 'connected' 이므로, planned(=capabilities
  // 미확인)는 '아직 연동 전'이 아니라 '붙어는 있는데 서버 한도 지원 여부를 모름'
  // 입니다. 아래 ledger-note 문구도 그 뜻으로 적습니다.
  const quotaStates = ledgerRows.map((row) => ({ row, quota: serverQuotaState(row), window: featuredQuotaWindow(row) }));
  // 서로 다른 구독의 percent 는 공통 분모가 없습니다 — 평균 내지 않고 가장 많이
  // 쓴 provider 하나만 대표로 세우고 카드 제목에 그 이름을 적습니다(R5).
  const quotaLeader = quotaStates
    .filter((entry) => entry.quota.state === 'observed' && entry.window)
    .sort((left, right) => (right.window.usedPercent ?? 0) - (left.window.usedPercent ?? 0))[0] ?? null;
  const featuredQuota = quotaLeader?.window ?? null;
  const quotaSplitTitle = quotaStates
    .map((entry) => `${entry.row.name}: ${entry.quota.state === 'observed' ? `${windowLabel(entry.window)} ${formatPercent(entry.window.usedPercent)} · ${resetLabel(entry.window)}` : entry.quota.label}`)
    .join('\n');
  const serverObserved = quotaStates.some((entry) => entry.quota.state === 'observed');
  // '모른다'가 '없다'를 이깁니다 — 한 곳이라도 미확인이면 화면 전체를 두고
  // '한도 미제공'이라고 말할 수 없습니다.
  const serverLedger = serverLedgerCopy[serverObserved
    ? 'observed'
    : quotaStates.some((entry) => entry.quota.state === 'waiting')
      ? 'waiting'
      : quotaStates.some((entry) => entry.quota.state === 'planned')
        ? 'planned'
        : quotaStates.length ? 'none' : 'unknown'];
  // 냥코멘트는 "서버와 로컬을 대조했다"는 이야기입니다 — 서버 원장이 있는
  // provider 것만 먹여야 합니다. 아무 provider 나 먼저 잡으면 Claude 데이터 위에
  // Codex 의 대조 서사를 얹게 됩니다.
  // 이름도 같이 넘깁니다 — 문구가 "이 PC의 로컬 ○○ 로그"라고 말하는 이상,
  // 그 ○○ 는 지금 먹인 reconciliation 의 주인이어야 합니다.
  const ledgerOwner = ledgerRows.find((row) => row.capabilities?.serverQuota) ?? null;
  const [commentTitle, commentText] = reconcileCopy(ledgerOwner?.reconciliation, ledgerOwner?.name);
  // hook 은 provider 마다 따로 설치됩니다. 고르는 기준은 동기화 화면과 같은
  // capabilities.hooks 입니다 — 'codex' 하나만 보면 M3 부터 있던 Claude hook 이
  // 대시보드에서만 사라지고, 칩의 '연결' 이 누구 이야기인지도 알 수 없습니다.
  // 설정 파일을 아직 못 읽었거나(status 없음) 읽기에 실패한 상태(status.error)는
  // '미설치'가 아니라 '미확인' 입니다 — 안 걸려 있다는 관측이 아닙니다(R7).
  // installed 는 기대 이벤트가 '전부' 걸렸을 때만 true 입니다(providers/*/hooks.mjs).
  // 그래서 일부만 걸린 설정을 '미설치'라고 적으면, 사용자의 설정 파일에 이미 우리
  // hook 이 들어 있는데도 없다고 말하게 됩니다 — 버튼은 남은 것만 채우면 되므로
  // 그대로 '설치' 입니다.
  const hookRows = providerRows.filter((item) => item.capabilities?.hooks).map((item) => {
    const status = hookStatuses?.[item.id] ?? null;
    const known = Boolean(status) && !status.error;
    const partial = known && !status.installed && Boolean(status.installedEvents?.length);
    return { id: item.id, name: item.name, installed: known && Boolean(status.installed), state: !known ? '미확인' : status.installed ? '연결' : partial ? '일부 설치' : '미설치' };
  });
  const hookInstalled = hookRows.some((item) => item.installed);
  // 분모는 겹치지 않는 프롬프트 쪽 토큰입니다. provider 마다 캐시가 input 안에
  // 있는지 밖에 있는지 다르므로 엔진이 회계에 맞춰 계산해 내려줍니다.
  // 아직 아무것도 안 쟀으면 0% 가 아니라 '—' 입니다(R7). 같은 이유로 바로 아래
  // 분자/분모 줄도 '0 / 0 프롬프트 토큰'을 찍지 않습니다 — 큰 숫자는 '—' 라고
  // 해 놓고 그 밑에 잰 적 없는 0 을 둘이나 적으면 카드가 스스로와 어긋납니다.
  const cachePercent = cacheHitPercent(totals);
  // 합계 하나로는 누구의 적중률인지 알 수 없습니다. Codex 수만 토큰과 Claude
  // 수십억 토큰을 합치면 화면에 남는 건 사실상 Claude 값뿐이고, 두 provider 는
  // 캐시 회계가 반대라 합계 비율에 깨끗한 의미도 없습니다.
  // 회계 이름은 툴팁이 아니라 화면에 적습니다 — 터치에는 hover 가 없고 보조기술도
  // title 을 읽어 준다는 보장이 없어, 76% 와 95% 만 남으면 두 수가 같은 종류로
  // 읽힙니다. 툴팁은 분모까지 보여주는 덤일 뿐입니다.
  const cacheBreakdown = providerRows
    .filter((item) => (item.periodTokens?.promptTokens ?? 0) > 0)
    .map((item) => ({
      id: item.id,
      name: item.name,
      percent: cacheHitPercent(item.periodTokens),
      accounting: accountingLabels[item.tokenAccounting] ?? '회계 미확인',
      cached: item.periodTokens.cachedInputTokens,
      prompt: item.periodTokens.promptTokens,
    }));
  const cacheBreakdownTitle = cacheBreakdown
    .map((row) => `${row.name}: ${formatTokens(row.cached)} / ${formatTokens(row.prompt)} 프롬프트 토큰 (${row.accounting})`)
    .join('\n');
  // 합산 한 줄로는 Input 이 무엇의 합인지 말할 수 없습니다. Codex 의 inputTokens 는
  // 캐시 읽기를 포함하고 Claude 의 것은 포함하지 않아, 둘을 더한 수는 어느 회계로도
  // 참이 아닙니다(R4). 합계에 decomposeTokens 를 먹이는 길도 있지만 두 항등식 중
  // 어느 것도 성립하지 않아 fallback(원본 범주 그대로)으로 떨어지고, 결국 지금과
  // 같은 뒤섞인 수가 그대로 남습니다 — 그래서 provider 마다 한 줄씩, 각자의 회계로
  // 분해하고 그 회계 이름을 옆에 적습니다.
  const tokenSplits = buildProviderTokenSplits(
    providerRows,
    new Map(providerRows.map((item) => [item.id, item.periodTokens])),
  );
  const connectedProviders = providerRows.filter((provider) => provider.integration === 'connected' || provider.measurement);
  // 품질 등급은 이번 달 창으로만 계산됩니다. 다른 기간의 합계에 붙이면 남의
  // 기간의 사실을 말하게 되므로, 그때는 배지를 만들지 않습니다.
  const totalsQuality = monthScoped ? aggregateQuality(snapshot?.providers ?? []) : null;
  const measuredProviderNames = providerRows.filter((item) => item.tokens > 0).map((item) => item.name);
  const fieldSummary = useMemo(() => {
    const rows = (snapshot?.providers ?? []).filter((provider) => (provider?.totals?.totalTokens ?? 0) > 0);
    // 필드 근거를 안 남기는 provider(Codex)는 툴팁에서 빈 줄만 만들므로 뺍니다.
    return rows
      .map((provider) => ({ provider: provider.name, fields: qualityFieldSummary(provider.quality) }))
      .filter((row) => row.fields.length > 0);
  }, [snapshot]);
  const fieldSummaryTitle = fieldSummary
    .map((row) => `${row.provider}: ${row.fields.map((field) => field.text).join(' · ')}`)
    .join('\n');

  return (
    <>
      <section className="collector-strip" aria-label="수집 상태">
        <div className={`collector-chip ${collectorDetected ? 'ok' : 'wait'}`}><span>로그</span><strong>{collectorDetected ? `${collectingProviders.map((item) => item.name).join(' · ')} 발견` : '미발견'}</strong></div>
        <div className={`collector-chip ${collectorWatching ? 'ok' : 'wait'}`}><span>실시간</span><strong>{collectorWatching ? `${watchedFileCount.toLocaleString('ko-KR')}개 파일 감시 중` : 'reconcile 대기'}</strong></div>
        <div className={`collector-chip ${serverObserved ? 'server' : 'wait'}`}><span>서버</span><strong>{serverLedger.chip}</strong></div>
        <div className={`collector-chip ${hookInstalled ? 'ok' : 'wait'}`}><span>Hook</span><strong>{hookRows.length ? hookRows.map((item) => `${item.name} ${item.state}`).join(' · ') : snapshot?.providers?.length ? 'hook 지원 provider 없음' : '미확인'}</strong></div>
        <div className="hook-buttons">{hookRows.map((item) => <button type="button" className="hook-button" key={item.id} onClick={() => onToggleHooks(item.id)} disabled={!api?.hooks || actionBusy}>{item.name} Hook {item.installed ? '해제' : '설치'}</button>)}</div>
      </section>

      {/* 기간 칩. 이번 달은 SSE 스냅샷을 그대로 쓰고, 그 밖의 기간만 REST 로
          당깁니다. 어느 요소가 이 칩을 따르고 어느 요소가 이번 달로 남는지는
          아래 각 블록의 표기로 드러냅니다. */}
      <section className="period-strip" role="group" aria-label="기간">
        <span className="filter-label">기간</span>
        {PERIODS.map((item) => (
          <button
            type="button"
            key={item.id}
            className={`chip-button ${period === item.id ? 'primary' : ''}`}
            onClick={() => setPeriod(item.id)}
          >{item.label}</button>
        ))}
        <p className="filter-note">
          {monthScoped
            ? '요약 카드와 AI별 사용량은 이번 달 · 실시간 갱신'
            : '요약 카드와 AI별 사용량은 전체 기간 · 서버 한도와 프로젝트 표는 이번 달로 남습니다'}
          {periodError ? ` · 기간 합계를 불러오지 못했어요: ${periodError}` : ''}
        </p>
      </section>

      <section className="summary-grid" aria-label="사용량 요약">
        <article className="stat-card"><div className="stat-label">{monthScoped ? '이번 달' : '전체 기간'} 총 토큰 <span>••</span></div><strong className={pending ? 'stat-pending' : undefined}>{tokensText(totals.totalTokens, pending)}</strong><p title={monthScoped ? fieldSummaryTitle : undefined}>{totalsQuality
          ? <><em className={`quality ${totalsQuality.tone}`}>● {pending ? '측정값 대기' : totalsQuality.label}</em> · {pending ? '로그를 읽는 중이에요' : measuredProviderNames.join(' · ') || '관측 대기'}</>
          /* 품질 등급은 이번 달 창으로만 계산됩니다. 다른 기간의 합계에 붙이면
             남의 기간의 사실을 말하게 되므로 배지를 만들지 않고 그 이유를 적습니다. */
          : <>기간 합계에는 품질 등급을 붙이지 않습니다 · {measuredProviderNames.join(' · ') || '관측 대기'}</>}</p><i className="brush mint-brush"/></article>
        <article className="stat-card"><div className="stat-label">캐시 적중 <span>••</span></div><strong className={pending ? 'mint-text stat-pending' : 'mint-text'}>{percentText(cachePercent, pending)}</strong><p>{pending ? '아직 서버에서 값이 오지 않았어요' : cachePercent === null ? '아직 관측된 프롬프트 토큰이 없어요' : `${formatTokens(totals.cachedInputTokens)} / ${formatTokens(totals.promptTokens)} 프롬프트 토큰`}</p>{!pending && cacheBreakdown.length ? <p className="stat-split" title={cacheBreakdownTitle}>{cacheBreakdown.map((row) => <span key={row.id}>{row.name} <b>{formatPercent(row.percent)}</b> <i>{row.accounting}</i></span>)}</p> : null}<div className="plant" aria-hidden="true"><b>⌁</b><i/></div></article>
        {/* 이 카드는 pending 으로 가리지 않습니다. pending 은 **토큰** 측정값이
            아직 안 왔다는 뜻이고(measurementPending 은 totals.eventCount 를 봅니다),
            서버 한도 snapshot 은 다른 레인으로 먼저 도착합니다. 토큰 기준으로
            가리면 이 카드가 '로딩중..' 인데 아래 서버 동기화 패널은 36% 를
            보여주는, 화면이 스스로와 어긋나는 상태가 됩니다. 한도 쪽의 "아직
            없음"은 serverQuotaState 가 이미 네 갈래로 구분합니다. */}
        <article className="stat-card"><div className="stat-label">서버 {featuredQuota ? windowLabel(featuredQuota) : '한도'}{quotaLeader ? ` · ${quotaLeader.row.name}` : ''} <span>••</span></div><strong className="orange-text">{featuredQuota ? formatPercent(featuredQuota.usedPercent) : '—'}</strong><p><em className={`quality ${serverLedger.tone}`}>● {serverLedger.label}</em> {featuredQuota ? `· ${relativeTime(featuredQuota.observedAt)}` : `· ${serverLedger.note}`}{' · 기간 무관'}</p>{quotaStates.length ? <p className="stat-split" title={quotaSplitTitle}>{quotaStates.map((entry) => <span key={entry.row.id}>{entry.row.name} <b>{entry.quota.state === 'observed' ? formatPercent(entry.window.usedPercent) : entry.quota.label}</b></span>)}</p> : null}<i className="brush peach-brush"/></article>
        <article className="stat-card"><div className="stat-label">현재 수집 AI <span>••</span></div><strong className="violet-text stat-ai">{connectedProviders.map((provider) => provider.name).join(' · ') || '대기 중'}</strong><p>{discoveredFileCount.toLocaleString('ko-KR')}개 세션 파일 · {tokensText(totals.outputTokens, pending)} output</p><span className="crown" aria-hidden="true">♕</span></article>
      </section>

      <section className="main-grid">
        <article className="panel usage-panel">
          <div className="panel-head"><div><h2>AI별 사용량 <span>••</span></h2><p className="panel-sub">공통 provider snapshot · Codex → Claude → Cursor → Gemini · {monthScoped ? '이번 달' : '전체 기간'}</p></div>{totalsQuality
            ? <span className={`quality ${totalsQuality.tone}`}>이번 달 {totalsQuality.label}</span>
            : <span className="quality">전체 기간 · 등급 없음</span>}</div>
          <CatArt className="peek-cat" pose="peek" label={`${currentTheme.label} 차트 고양이 드로잉`} />
          <div className="usage-chart">
            {providerRows.map((item) => {
              // 로그가 발견된 provider 만 "로딩중" 입니다. Cursor·Gemini 는
              // 어댑터가 아직 없어 스캔이 끝나도 값이 오지 않으므로, 여기에
              // 로딩을 적으면 지킬 수 없는 약속이 됩니다 — 그 둘의 사실은
              // '준비 중' 이고 값은 '—' 입니다(R7).
              const rowPending = pending && Boolean(item.collector?.detected);
              // 이번 달이 0 이어도 전체 기간 기록이 있으면 "관측 대기" 는 거짓
              // 입니다 — 이미 관측했고 이번 달에 활동이 없을 뿐입니다(R7).
              // Gemini 어댑터를 붙이고 이 상황이 처음 생겼습니다: 원장에 9.8억
              // 토큰이 있는데 대시보드가 "관측 대기 · —" 라고 말했습니다.
              // 큰 숫자 자리는 이번 달 몫으로 남깁니다 — 이 패널의 막대와 비중이
              // 이번 달 기준이라, 거기에 전체 기간 값을 넣으면 비교가 깨집니다.
              const label = providerActivityLabel({
                pending: rowPending,
                badgeLabel: item.badge?.label ?? null,
                periodTokens: item.tokens,
                allTimeTokens: item.allTimeTotals?.totalTokens ?? 0,
                measurement: item.measurement,
                status: item.status,
                // 이번 달이 아니면 품질 등급이 없습니다 — 값이 찍힌 행에
                // "관측 대기" 를 적지 않도록 그 사실을 넘깁니다.
                gradeUnavailable: !monthScoped,
              });
              return <div className={`usage-row ${item.tokens === 0 ? 'usage-row--pending' : ''}`} key={item.id}><div className="ai-name"><span className={`ai-mark ${item.tone}`}>{item.short}</span><span>{item.name}<small>{label}</small></span></div><div className="bar-track"><div className={`bar ${item.tone}`} style={{ width: item.tokens ? `${Math.max(3, (item.tokens / maxTokens) * 100)}%` : '0%' }}/></div><strong>{tokensOrDash(item.tokens, rowPending)}</strong><span>{rowPending ? PENDING_LABEL : item.tokens && totals.totalTokens ? formatPercent((item.tokens / totals.totalTokens) * 100, 1) : '—'}</span></div>;
            })}
          </div>
          <div className="token-breakdown">{tokenSplits.length ? tokenSplits.map((split) => <div className="token-split" key={split.id}><span className="token-split-name">{split.name}<small>{split.accounting}{split.nested ? '' : ' · 겹침 미확인'}</small></span><div className="token-split-cells">{split.segments.map((segment) => <span key={segment.key}><i className={`legend-dot ${segment.tone}`}/>{segment.label} <strong>{segment.value ? formatTokens(segment.value) : '—'}</strong></span>)}{split.extras.map((extra) => <span className="token-split-extra" key={extra.key}><i className={`legend-dot ${extra.tone}`}/>{extra.label} <strong>{formatTokens(extra.value)}</strong> ({extra.note})</span>)}</div></div>) : <p className="ledger-note">{pending ? '로그를 읽는 중이에요 — 분해는 측정값이 도착한 뒤에 그립니다.' : totals.eventCount ? '아직 분해할 토큰이 없습니다 — 수집된 이벤트는 있지만 토큰이 0입니다.' : '아직 분해할 토큰이 없습니다 — 이번 달 수집된 사용 이벤트가 없어요.'}</p>}</div>
        </article>

        <article className="panel budget-panel quota-panel">
          <div className="panel-head"><div><h2>서버 동기화 <span>••</span></h2><p className="panel-sub">토큰과 quota를 같은 숫자로 환산하지 않습니다 · 현재 서버 snapshot(기간 무관)</p></div><span className="paw-dots">•• ••</span></div>
          <div className="quota-body">
            {quotaStates.length ? quotaStates.map(({ row, quota }) => <div className="ledger-block" key={row.id}>
              <div className="ledger-head"><span className={`ai-mark ${row.tone}`}>{row.short}</span>{row.name}<small>{quota.label ?? '서버 관측'}</small></div>
              {quota.state === 'observed' || quota.state === 'waiting'
                ? (quota.state === 'observed' ? providerQuotaWindows(row) : quotaPlaceholderRows).map((window, index) => <div className="quota-row" key={`${window.limitId ?? 'pending'}-${window.windowType ?? index}`}><div className="quota-copy"><span>{quotaLabel(window)}</span><strong>{window.unavailable ? '—' : formatPercent(window.usedPercent)}</strong><small>{window.unavailable ? '서버 snapshot을 기다리는 중' : resetLabel(window)}</small></div><div className="quota-track"><i style={{ width: `${window.unavailable ? 0 : window.usedPercent ?? 0}%` }}/></div></div>)
                : <p className="ledger-note">{quota.state === 'none' ? '한도 미제공 — 이 provider는 서버 한도를 기록하지 않습니다.' : '이 provider가 서버 한도를 남기는지 아직 확인하지 못했습니다.'}</p>}
              {quota.state === 'none'
                ? <div className="reconcile-box"><strong>서버 원장 없음</strong><span>로컬 관측만</span></div>
                : quota.state === 'planned'
                  ? null
                  : <div className={`reconcile-box ${row.reconciliation?.status === 'UNATTRIBUTED_SERVER_USAGE' ? 'warn' : ''}`}><strong>{row.reconciliation?.status === 'UNATTRIBUTED_SERVER_USAGE' ? '미확인 서버 변동 있음' : quota.state === 'observed' ? '서버 ↔ 로컬 대조 중' : '서버 snapshot 대기'}</strong><span>{reconcileCounts(row.reconciliation) ?? '아직 대조한 구간이 없습니다 — 서버 snapshot이 쌓이면 로컬 활동과 비교합니다'}</span></div>}
            </div>) : <p className="ledger-note">연동된 provider가 없어 대조할 서버 원장이 아직 없습니다.</p>}
            <CatArt className="sleep-cat" pose="sleep" label={`${currentTheme.label} 잠든 고양이 드로잉`} />
          </div>
        </article>
      </section>

      <section className="panel projects-panel">
        <div className="panel-head"><div><h2>최근 프로젝트 발자국 <span>••</span></h2>
          {/* 목록에 무엇이 담기는지(마지막 활동 기준 상위 몇 개)와 그것을 어떤
              순서로 세웠는지는 다른 사실입니다. 정렬을 바꿨는데 부제가 계속
              "마지막 활동 순"이라고 적혀 있으면 화면이 스스로와 어긋나고,
              반대로 "토큰 순"으로만 적으면 전체에서 토큰 상위를 뽑은 것처럼
              읽힙니다 — 실제로는 최근 목록 안에서만 다시 세운 것입니다. */}
          <p className="panel-sub">provider별 세션 메타데이터의 cwd 기준 자동 분류 · <strong>이번 달</strong> 마지막 활동 기준 최근 {projects.length}개를 {projectSortLabel} {projectSort.direction === 'asc' ? '오름차순' : '내림차순'}으로 정렬</p></div><span className="quality local">이번 달</span></div>
        <div className="project-table" role="table">
          <TableHead className="project-row project-header" columns={PROJECT_COLUMNS} sort={projectSort} onSort={toggleProjectSort} />
          {sortedProjects.length ? sortedProjects.map((project, index) => {
            const provider = providerRows.find((item) => item.id === project.provider) ?? providerRows[0];
            return <div className="project-row" role="row" key={`${project.provider}-${project.name}-${project.cwd ?? index}`}><div className="project-name"><span className={`folder ${['green','orange','blue'][index % 3]}`}/><div><strong>{project.name}</strong><small>{project.cwd || project.model || `${provider?.name ?? 'AI'} session`}</small></div></div><div className="project-ai"><span className={`ai-mark ${provider?.tone ?? 'mint'}`}>{provider?.short ?? '?'}</span>{provider?.name ?? project.provider}</div><strong>{formatTokens(project.totalTokens)}</strong><span>{relativeTime(project.lastActivity)}</span></div>;
          }) : pending
            ? <div className="empty-projects"><strong>로딩중..</strong><span>로그를 읽는 중이에요. 프로젝트가 확인되는 대로 이 표에 채워집니다.</span></div>
            : <div className="empty-projects"><strong>아직 이번 달 AI 사용 기록이 없어요.</strong><span>연결된 provider 로그가 발견되면 과거 기록부터 자동으로 채웁니다.</span></div>}
        </div>
      </section>

      <section className="cat-comment">
        <CatArt className="comment-cat" pose="yarn" label={`${currentTheme.label} 실타래 고양이 드로잉`} />
        <div className="comment-title">오늘의<br/><strong>냥코멘트</strong></div>
        <div className="comment-copy"><p><strong>{commentTitle}</strong></p><p>{commentText}</p></div>
        <div className="heart-doodle" aria-hidden="true">♡</div>
      </section>

      <p className="data-note">토큰: provider 로컬 원장 관측값 · 서버 한도: provider가 기록한 quota snapshot · 서로 다른 측정값을 강제로 보정하지 않습니다. DB: {snapshot?.diagnostics?.dbPath ? 'SQLite 연결됨' : api ? '초기화 중' : '웹 미리보기 모드'}</p>
    </>
  );
}
