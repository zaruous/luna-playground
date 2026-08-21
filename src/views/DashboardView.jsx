import { useMemo } from 'react';
import CatArt from '../CatArt.jsx';
import {
  providerCatalog, formatTokens, formatPercent, relativeTime,
  windowLabel, quotaLabel, resetLabel, reconcileCopy,
  aggregateQuality, qualityBadge, qualityFieldSummary,
  cacheHitPercent, accountingLabels, serverQuotaState, featuredQuotaWindow, providerQuotaWindows,
} from '../shared.js';

// snapshot 을 아직 못 받은 서버 원장 provider 에만 쓰는 자리표시자입니다.
// serverQuota 가 false 인 provider 에 재사용하면 존재하지도 않는 5시간/주간
// 한도 창 두 개를 지어내게 됩니다.
const quotaPlaceholderRows = [
  { windowType:'primary', windowMinutes:300, unavailable:true },
  { windowType:'secondary', windowMinutes:10080, unavailable:true },
];

export default function DashboardView({ snapshot, hookStatus, api, actionBusy, currentTheme, onToggleHooks }) {
  const totals = snapshot?.totals ?? { totalTokens:0, inputTokens:0, cachedInputTokens:0, cacheWriteInputTokens:0, outputTokens:0, reasoningTokens:0, promptTokens:0, cacheRate:0 };
  const projects = snapshot?.projects ?? [];

  const providerRows = useMemo(() => {
    const measuredProviders = snapshot?.providers?.length ? snapshot.providers : providerCatalog;
    return measuredProviders.map((measured) => {
      const provider = providerCatalog.find((item) => item.id === measured.id) ?? {
        id: measured.id, name: measured.name, short: measured.name?.slice(0, 2) ?? '?', tone: 'mint', status: '연동됨',
      };
      const tokens = measured?.totals?.totalTokens ?? 0;
      const status = measured?.integration === 'connected' ? '연동됨' : provider.status;
      return {
        ...provider, ...measured, status, tokens,
        measurement: measured?.measurement ?? null,
        badge: tokens ? qualityBadge(measured?.quality) : null,
      };
    });
  }, [snapshot]);
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
  // 냥코멘트는 "서버와 로컬을 대조했다"는 이야기입니다 — 서버 원장이 있는
  // provider 것만 먹여야 합니다. 아무 provider 나 먼저 잡으면 Claude 데이터 위에
  // Codex 의 대조 서사를 얹게 됩니다.
  const [commentTitle, commentText] = reconcileCopy(ledgerRows.find((row) => row.capabilities?.serverQuota)?.reconciliation);
  const hookInstalled = Boolean(hookStatus?.installed);
  // 분모는 겹치지 않는 프롬프트 쪽 토큰입니다. provider 마다 캐시가 input 안에
  // 있는지 밖에 있는지 다르므로 엔진이 회계에 맞춰 계산해 내려줍니다.
  // 아직 아무것도 안 쟀으면 0% 가 아니라 '—' 입니다(R7).
  const cachePercent = cacheHitPercent(totals);
  // 합계 하나로는 누구의 적중률인지 알 수 없습니다. Codex 수만 토큰과 Claude
  // 수십억 토큰을 합치면 화면에 남는 건 사실상 Claude 값뿐이고, 두 provider 는
  // 캐시 회계가 반대라 합계 비율에 깨끗한 의미도 없습니다.
  const cacheBreakdown = providerRows
    .filter((item) => (item.totals?.promptTokens ?? 0) > 0)
    .map((item) => ({
      id: item.id,
      name: item.name,
      percent: cacheHitPercent(item.totals),
      accounting: accountingLabels[item.tokenAccounting] ?? '회계 미확인',
      cached: item.totals.cachedInputTokens,
      prompt: item.totals.promptTokens,
    }));
  const cacheBreakdownTitle = cacheBreakdown
    .map((row) => `${row.name}: ${formatTokens(row.cached)} / ${formatTokens(row.prompt)} 프롬프트 토큰 (${row.accounting})`)
    .join('\n');
  const connectedProviders = providerRows.filter((provider) => provider.integration === 'connected' || provider.measurement);
  const totalsQuality = aggregateQuality(snapshot?.providers ?? []);
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
        <div className={`collector-chip ${serverObserved ? 'server' : 'wait'}`}><span>서버</span><strong>{serverObserved ? '한도 snapshot' : 'snapshot 대기'}</strong></div>
        <div className={`collector-chip ${hookInstalled ? 'ok' : 'wait'}`}><span>Hook</span><strong>{hookInstalled ? '보조 신호 연결' : '선택 설치'}</strong></div>
        <button type="button" className="hook-button" onClick={onToggleHooks} disabled={!api?.codex || actionBusy}>{hookInstalled ? 'Stop Hook 해제' : '실시간 Hook 설치'}</button>
      </section>

      <section className="summary-grid" aria-label="사용량 요약">
        <article className="stat-card"><div className="stat-label">이번 달 총 토큰 <span>••</span></div><strong>{formatTokens(totals.totalTokens)}</strong><p title={fieldSummaryTitle}><em className={`quality ${totalsQuality.tone}`}>● {totalsQuality.label}</em> · {measuredProviderNames.join(' · ') || '관측 대기'}</p><i className="brush mint-brush"/></article>
        <article className="stat-card"><div className="stat-label">캐시 적중 <span>••</span></div><strong className="mint-text">{formatPercent(cachePercent)}</strong><p>{formatTokens(totals.cachedInputTokens)} / {formatTokens(totals.promptTokens)} 프롬프트 토큰</p>{cacheBreakdown.length ? <p className="stat-split" title={cacheBreakdownTitle}>{cacheBreakdown.map((row) => <span key={row.id}>{row.name} <b>{formatPercent(row.percent)}</b></span>)}</p> : null}<div className="plant" aria-hidden="true"><b>⌁</b><i/></div></article>
        <article className="stat-card"><div className="stat-label">서버 {featuredQuota ? windowLabel(featuredQuota) : '한도'}{quotaLeader ? ` · ${quotaLeader.row.name}` : ''} <span>••</span></div><strong className="orange-text">{featuredQuota ? formatPercent(featuredQuota.usedPercent) : '—'}</strong><p><em className="quality server">● 서버 관측</em> {featuredQuota ? `· ${relativeTime(featuredQuota.observedAt)}` : '· 대기 중'}</p>{quotaStates.length ? <p className="stat-split" title={quotaSplitTitle}>{quotaStates.map((entry) => <span key={entry.row.id}>{entry.row.name} <b>{entry.quota.state === 'observed' ? formatPercent(entry.window.usedPercent) : entry.quota.label}</b></span>)}</p> : null}<i className="brush peach-brush"/></article>
        <article className="stat-card"><div className="stat-label">현재 수집 AI <span>••</span></div><strong className="violet-text stat-ai">{connectedProviders.map((provider) => provider.name).join(' · ') || '대기 중'}</strong><p>{discoveredFileCount.toLocaleString('ko-KR')}개 세션 파일 · {formatTokens(totals.outputTokens)} output</p><span className="crown" aria-hidden="true">♕</span></article>
      </section>

      <section className="main-grid">
        <article className="panel usage-panel">
          <div className="panel-head"><div><h2>AI별 사용량 <span>••</span></h2><p className="panel-sub">공통 provider snapshot · Codex → Claude → Cursor → Gemini</p></div><span className={`quality ${totalsQuality.tone}`}>이번 달 {totalsQuality.label}</span></div>
          <CatArt className="peek-cat" pose="peek" label={`${currentTheme.label} 차트 고양이 드로잉`} />
          <div className="usage-chart">
            {providerRows.map((item) => <div className={`usage-row ${item.tokens === 0 ? 'usage-row--pending' : ''}`} key={item.id}><div className="ai-name"><span className={`ai-mark ${item.tone}`}>{item.short}</span><span>{item.name}<small>{item.badge ? item.badge.label : item.measurement ? '관측 대기' : item.status}</small></span></div><div className="bar-track"><div className={`bar ${item.tone}`} style={{ width: item.tokens ? `${Math.max(3, (item.tokens / maxTokens) * 100)}%` : '0%' }}/></div><strong>{item.tokens ? formatTokens(item.tokens) : '—'}</strong><span>{item.tokens && totals.totalTokens ? formatPercent((item.tokens / totals.totalTokens) * 100, 1) : '—'}</span></div>)}
          </div>
          <div className="token-breakdown"><span>Input <strong>{formatTokens(totals.inputTokens)}</strong></span><span>Cached <strong>{formatTokens(totals.cachedInputTokens)}</strong></span><span>Cache write <strong>{formatTokens(totals.cacheWriteInputTokens)}</strong></span><span>Output <strong>{formatTokens(totals.outputTokens)}</strong></span><span>Reasoning <strong>{formatTokens(totals.reasoningTokens)}</strong></span></div>
        </article>

        <article className="panel budget-panel quota-panel">
          <div className="panel-head"><div><h2>서버 동기화 <span>••</span></h2><p className="panel-sub">토큰과 quota를 같은 숫자로 환산하지 않습니다.</p></div><span className="paw-dots">•• ••</span></div>
          <div className="quota-body">
            {quotaStates.length ? quotaStates.map(({ row, quota }) => <div className="ledger-block" key={row.id}>
              <div className="ledger-head"><span className={`ai-mark ${row.tone}`}>{row.short}</span>{row.name}<small>{quota.label ?? '서버 관측'}</small></div>
              {quota.state === 'observed' || quota.state === 'waiting'
                ? (quota.state === 'observed' ? providerQuotaWindows(row) : quotaPlaceholderRows).map((window, index) => <div className="quota-row" key={`${window.limitId ?? 'pending'}-${window.windowType ?? index}`}><div className="quota-copy"><span>{quotaLabel(window)}</span><strong>{window.unavailable ? '—' : formatPercent(window.usedPercent)}</strong><small>{window.unavailable ? '서버 snapshot을 기다리는 중' : resetLabel(window)}</small></div><div className="quota-track"><i style={{ width: `${window.unavailable ? 0 : window.usedPercent ?? 0}%` }}/></div></div>)
                : <p className="ledger-note">{quota.state === 'none' ? '한도 미제공 — 이 provider는 서버 한도를 기록하지 않습니다.' : '아직 연동 전이라 서버 한도를 관측한 적이 없습니다.'}</p>}
              {quota.state === 'none'
                ? <div className="reconcile-box"><strong>서버 원장 없음</strong><span>로컬 관측만</span></div>
                : quota.state === 'planned'
                  ? null
                  : <div className={`reconcile-box ${row.reconciliation?.status === 'UNATTRIBUTED_SERVER_USAGE' ? 'warn' : ''}`}><strong>{row.reconciliation?.status === 'UNATTRIBUTED_SERVER_USAGE' ? '미확인 서버 변동 있음' : quota.state === 'observed' ? '서버 ↔ 로컬 대조 중' : '서버 snapshot 대기'}</strong><span>최근 대조: matched {row.reconciliation?.matched ?? 0} · server-only {row.reconciliation?.serverOnly ?? 0} · local-only {row.reconciliation?.localOnly ?? 0}</span></div>}
            </div>) : <p className="ledger-note">연동된 provider가 없어 대조할 서버 원장이 아직 없습니다.</p>}
            <CatArt className="sleep-cat" pose="sleep" label={`${currentTheme.label} 잠든 고양이 드로잉`} />
          </div>
        </article>
      </section>

      <section className="panel projects-panel">
        <div className="panel-head"><div><h2>최근 프로젝트 발자국 <span>••</span></h2><p className="panel-sub">session_meta / turn_context의 cwd 기준 자동 분류</p></div><span className="quality local">이번 달</span></div>
        <div className="project-table" role="table">
          <div className="project-row project-header" role="row"><span>프로젝트</span><span>주 사용 AI</span><span>토큰 사용량</span><span>마지막 활동</span></div>
          {projects.length ? projects.map((project, index) => {
            const provider = providerRows.find((item) => item.id === project.provider) ?? providerRows[0];
            return <div className="project-row" role="row" key={`${project.provider}-${project.name}-${project.cwd ?? index}`}><div className="project-name"><span className={`folder ${['green','orange','blue'][index % 3]}`}/><div><strong>{project.name}</strong><small>{project.cwd || project.model || `${provider?.name ?? 'AI'} session`}</small></div></div><div className="project-ai"><span className={`ai-mark ${provider?.tone ?? 'mint'}`}>{provider?.short ?? '?'}</span>{provider?.name ?? project.provider}</div><strong>{formatTokens(project.totalTokens)}</strong><span>{relativeTime(project.lastActivity)}</span></div>;
          }) : <div className="empty-projects"><strong>아직 이번 달 AI 사용 기록이 없어요.</strong><span>연결된 provider 로그가 발견되면 과거 기록부터 자동으로 채웁니다.</span></div>}
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
