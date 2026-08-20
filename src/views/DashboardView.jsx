import { useMemo } from 'react';
import CatArt from '../CatArt.jsx';
import {
  providerCatalog, formatTokens, formatPercent, relativeTime,
  windowLabel, quotaLabel, resetLabel, reconcileCopy,
} from '../shared.js';

export default function DashboardView({ snapshot, hookStatus, api, actionBusy, currentTheme, onToggleHooks }) {
  const codex = snapshot?.providers?.find((item) => item.id === 'codex') ?? null;
  const totals = snapshot?.totals ?? { totalTokens:0, inputTokens:0, cachedInputTokens:0, cacheWriteInputTokens:0, outputTokens:0, reasoningTokens:0, cacheRate:0 };
  const quotaWindows = codex?.quotaWindows?.length
    ? codex.quotaWindows
    : [codex?.rateLimits?.primary, codex?.rateLimits?.secondary].filter(Boolean);
  const featuredQuota = quotaWindows.find((window) => window.windowMinutes === 300 && window.limitId === 'codex')
    ?? quotaWindows.find((window) => window.windowMinutes === 300)
    ?? quotaWindows[0]
    ?? null;
  const quotaRows = quotaWindows.length ? quotaWindows : [
    { windowType:'primary', windowMinutes:300, unavailable:true },
    { windowType:'secondary', windowMinutes:10080, unavailable:true },
  ];
  const projects = snapshot?.projects ?? [];
  const [commentTitle, commentText] = reconcileCopy(codex?.reconciliation);

  const providerRows = useMemo(() => {
    const measuredProviders = snapshot?.providers?.length ? snapshot.providers : providerCatalog;
    return measuredProviders.map((measured) => {
      const provider = providerCatalog.find((item) => item.id === measured.id) ?? {
        id: measured.id, name: measured.name, short: measured.name?.slice(0, 2) ?? '?', tone: 'mint', status: '연동됨',
      };
      const tokens = measured?.totals?.totalTokens ?? 0;
      const status = measured?.integration === 'connected' ? '연동됨' : provider.status;
      return { ...provider, ...measured, status, tokens, measurement: measured?.measurement ?? null };
    });
  }, [snapshot]);
  const maxTokens = Math.max(1, ...providerRows.map((item) => item.tokens));

  const collectorDetected = Boolean(codex?.collector?.detected);
  const collectorWatching = Boolean(codex?.collector?.watching);
  const serverObserved = quotaWindows.length > 0;
  const hookInstalled = Boolean(hookStatus?.installed);
  const cachePercent = totals.inputTokens ? totals.cacheRate * 100 : 0;
  const connectedProviders = providerRows.filter((provider) => provider.integration === 'connected' || provider.measurement);

  return (
    <>
      <section className="collector-strip" aria-label="Codex 수집 상태">
        <div className={`collector-chip ${collectorDetected ? 'ok' : 'wait'}`}><span>로그</span><strong>{collectorDetected ? 'Codex 발견' : '미발견'}</strong></div>
        <div className={`collector-chip ${collectorWatching ? 'ok' : 'wait'}`}><span>실시간</span><strong>{collectorWatching ? '파일 감시 중' : 'reconcile 대기'}</strong></div>
        <div className={`collector-chip ${serverObserved ? 'server' : 'wait'}`}><span>서버</span><strong>{serverObserved ? '한도 snapshot' : 'snapshot 대기'}</strong></div>
        <div className={`collector-chip ${hookInstalled ? 'ok' : 'wait'}`}><span>Hook</span><strong>{hookInstalled ? '보조 신호 연결' : '선택 설치'}</strong></div>
        <button type="button" className="hook-button" onClick={onToggleHooks} disabled={!api?.codex || actionBusy}>{hookInstalled ? 'Stop Hook 해제' : '실시간 Hook 설치'}</button>
      </section>

      <section className="summary-grid" aria-label="사용량 요약">
        <article className="stat-card"><div className="stat-label">이번 달 총 토큰 <span>••</span></div><strong>{formatTokens(totals.totalTokens)}</strong><p><em className="quality local">● 로컬 관측</em> · Codex rollout</p><i className="brush mint-brush"/></article>
        <article className="stat-card"><div className="stat-label">캐시 적중 <span>••</span></div><strong className="mint-text">{formatPercent(cachePercent)}</strong><p>{formatTokens(totals.cachedInputTokens)} cached input</p><div className="plant" aria-hidden="true"><b>⌁</b><i/></div></article>
        <article className="stat-card"><div className="stat-label">서버 {featuredQuota ? windowLabel(featuredQuota) : '한도'} <span>••</span></div><strong className="orange-text">{featuredQuota ? formatPercent(featuredQuota.usedPercent) : '—'}</strong><p><em className="quality server">● 서버 관측</em> {featuredQuota ? `· ${relativeTime(featuredQuota.observedAt)}` : '· 대기 중'}</p><i className="brush peach-brush"/></article>
        <article className="stat-card"><div className="stat-label">현재 수집 AI <span>••</span></div><strong className="violet-text stat-ai">{connectedProviders.map((provider) => provider.name).join(' · ') || '대기 중'}</strong><p>{codex?.collector?.filesDiscovered ?? 0}개 세션 파일 · {formatTokens(totals.outputTokens)} output</p><span className="crown" aria-hidden="true">♕</span></article>
      </section>

      <section className="main-grid">
        <article className="panel usage-panel">
          <div className="panel-head"><div><h2>AI별 사용량 <span>••</span></h2><p className="panel-sub">공통 provider snapshot · Codex → Claude → Cursor → Gemini</p></div><span className="quality local">이번 달 로컬 관측</span></div>
          <CatArt className="peek-cat" pose="peek" label={`${currentTheme.label} 차트 고양이 드로잉`} />
          <div className="usage-chart">
            {providerRows.map((item) => <div className={`usage-row ${item.tokens === 0 ? 'usage-row--pending' : ''}`} key={item.id}><div className="ai-name"><span className={`ai-mark ${item.tone}`}>{item.short}</span><span>{item.name}<small>{item.measurement ? '로컬 관측' : item.status}</small></span></div><div className="bar-track"><div className={`bar ${item.tone}`} style={{ width: item.tokens ? `${Math.max(3, (item.tokens / maxTokens) * 100)}%` : '0%' }}/></div><strong>{item.tokens ? formatTokens(item.tokens) : '—'}</strong><span>{item.tokens && totals.totalTokens ? formatPercent((item.tokens / totals.totalTokens) * 100) : '—'}</span></div>)}
          </div>
          <div className="token-breakdown"><span>Input <strong>{formatTokens(totals.inputTokens)}</strong></span><span>Cached <strong>{formatTokens(totals.cachedInputTokens)}</strong></span><span>Cache write <strong>{formatTokens(totals.cacheWriteInputTokens)}</strong></span><span>Output <strong>{formatTokens(totals.outputTokens)}</strong></span><span>Reasoning <strong>{formatTokens(totals.reasoningTokens)}</strong></span></div>
        </article>

        <article className="panel budget-panel quota-panel">
          <div className="panel-head"><div><h2>Codex 서버 동기화 <span>••</span></h2><p className="panel-sub">토큰과 quota를 같은 숫자로 환산하지 않습니다.</p></div><span className="paw-dots">•• ••</span></div>
          <div className="quota-body">
            {quotaRows.map((window, index) => <div className="quota-row" key={`${window.limitId ?? 'pending'}-${window.windowType ?? index}`}><div className="quota-copy"><span>{quotaLabel(window)}</span><strong>{window.unavailable ? '—' : formatPercent(window.usedPercent)}</strong><small>{window.unavailable ? '서버 snapshot을 기다리는 중' : resetLabel(window)}</small></div><div className="quota-track"><i style={{ width: `${window.unavailable ? 0 : window.usedPercent ?? 0}%` }}/></div></div>)}
            <div className={`reconcile-box ${codex?.reconciliation?.status === 'UNATTRIBUTED_SERVER_USAGE' ? 'warn' : ''}`}><strong>{codex?.reconciliation?.status === 'UNATTRIBUTED_SERVER_USAGE' ? '미확인 서버 변동 있음' : serverObserved ? '서버 ↔ 로컬 대조 중' : '서버 snapshot 대기'}</strong><span>최근 대조: matched {codex?.reconciliation?.matched ?? 0} · server-only {codex?.reconciliation?.serverOnly ?? 0} · local-only {codex?.reconciliation?.localOnly ?? 0}</span></div>
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
