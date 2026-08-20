import { useEffect, useMemo, useState } from 'react';
import CatArt from './CatArt.jsx';
import { createUsageClient } from './usage-client.js';

const catThemes = [
  { id: 'black', label: '블랙냥', hint: '차콜 · 크림 · 골드' },
  { id: 'white', label: '흰냥', hint: '아이보리 · 스카이블루' },
  { id: 'gray', label: '회색냥', hint: '스톤 · 세이지' },
  { id: 'orange', label: '주황냥', hint: '살구 · 테라코타' },
  { id: 'calico', label: '삼색냥', hint: '크림 · 먹색 · 오렌지' },
];

const navItems = [
  ['dashboard', '대시보드'], ['usage', 'AI 사용량'], ['project', '프로젝트'], ['budget', '동기화'], ['alert', '알림'], ['settings', '설정'],
];

const providerCatalog = [
  { id: 'codex', name: 'Codex', short: 'C', tone: 'violet', status: '연동됨' },
  { id: 'claude', name: 'Claude', short: 'Cl', tone: 'orange', status: '다음 단계' },
  { id: 'cursor', name: 'Cursor', short: 'Cu', tone: 'blue', status: '준비 중' },
  { id: 'gemini', name: 'Gemini', short: 'G', tone: 'mint', status: '준비 중' },
];

function NavIcon({ type }) {
  const paths = {
    dashboard: <><path d="M4 19V9h3v10M10.5 19V5h3v14M17 19v-7h3v7"/><path d="M3 21h18"/></>,
    usage: <><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A8.5 8.5 0 0 1 20.5 9H15z"/></>,
    project: <><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></>,
    budget: <><circle cx="12" cy="12" r="8"/><path d="M7 12h10M12 7v10"/></>,
    alert: <><path d="M6 17h12l-1.5-2.3V10a4.5 4.5 0 0 0-9 0v4.7z"/><path d="M10 20h4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.5 1a8 8 0 0 0-1.8-1L14.2 3h-4.4l-.4 3a8 8 0 0 0-1.8 1L5.1 6 3 9.4 5.1 11a7 7 0 0 0 0 2L3 14.6 5.1 18l2.5-1a8 8 0 0 0 1.8 1l.4 3h4.4l.4-3a8 8 0 0 0 1.8-1l2.5 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[type]}</svg>;
}

function formatTokens(value = 0) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(number >= 10_000_000_000 ? 1 : 2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return number.toLocaleString('ko-KR');
}

function formatPercent(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

function relativeTime(value) {
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

function windowLabel(window) {
  const minutes = window?.windowMinutes;
  if (minutes === 300) return '5시간 한도';
  if (minutes === 10080) return '주간 한도';
  if (minutes) return `${minutes}분 한도`;
  return '서버 한도';
}

function quotaLabel(window) {
  const base = windowLabel(window);
  const name = window?.limitName;
  if (!name || /^codex$/i.test(name)) return base;
  return `${name} · ${base}`;
}

function resetLabel(window) {
  if (!window?.resetsAt) return '리셋 시각 미확인';
  return `${new Date(window.resetsAt * 1000).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })} 리셋`;
}

function reconcileCopy(reconciliation) {
  switch (reconciliation?.status) {
    case 'UNATTRIBUTED_SERVER_USAGE': return ['서버 사용량 차이가 보인다냥', '서버 한도는 움직였지만 이 PC의 로컬 Codex 로그에서 대응 사용량을 찾지 못한 구간이 있어요. 다른 기기·클라우드 작업·지연 정산 가능성을 분리해서 기록 중입니다.'];
    case 'LOCAL_AHEAD_OF_SERVER': return ['로컬 로그가 먼저 달린다냥', '로컬 토큰은 증가했지만 서버 한도 snapshot은 아직 움직이지 않은 구간이 있어요. 다음 서버 snapshot에서 다시 대조합니다.'];
    case 'SYNCED': return ['로컬 기록과 서버 흐름이 잘 맞는다냥', '토큰량은 로컬 로그 원본을 보존하고, 서버 사용률은 별도 snapshot으로 저장해 서로 억지로 보정하지 않고 비교합니다.'];
    default: return ['Codex 기록을 관측 중이다냥', '토큰량은 로컬 rollout 로그 기준입니다. 서버 rate-limit snapshot이 들어오면 로컬 활동과 자동으로 대조합니다.'];
  }
}

function App() {
  const [activeNav, setActiveNav] = useState('dashboard');
  const [skinOpen, setSkinOpen] = useState(false);
  const [catTheme, setCatTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('nyangtracker-cat-theme');
    return catThemes.some((theme) => theme.id === savedTheme) ? savedTheme : 'black';
  });
  const [snapshot, setSnapshot] = useState(null);
  const [hookStatus, setHookStatus] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [lastUpdatePulse, setLastUpdatePulse] = useState(0);

  const api = useMemo(() => createUsageClient(window.__NYANG_TRACKER_CONFIG__), []);
  const currentTheme = catThemes.find((theme) => theme.id === catTheme) || catThemes[0];
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

  useEffect(() => {
    window.localStorage.setItem('nyangtracker-cat-theme', catTheme);
    document.body.dataset.catTheme = catTheme;
  }, [catTheme]);

  useEffect(() => {
    if (!api?.usage) return undefined;
    let active = true;
    api.usage.getSnapshot().then((value) => { if (active) setSnapshot(value); }).catch(() => {});
    api.codex?.getHookStatus?.().then((value) => { if (active) setHookStatus(value); }).catch(() => {});
    const unsubscribe = api.usage.subscribe((value) => {
      if (!active) return;
      setSnapshot(value);
      setLastUpdatePulse((pulse) => pulse + 1);
    });
    return () => { active = false; unsubscribe?.(); };
  }, [api]);

  useEffect(() => {
    if (!api?.usage) return undefined;
    let active = true;
    let pending = false;
    const reconcileOnReturn = () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      api.usage.rescan()
        .then((value) => { if (active) setSnapshot(value); })
        .catch(() => {})
        .finally(() => { pending = false; });
    };
    window.addEventListener('focus', reconcileOnReturn);
    document.addEventListener('visibilitychange', reconcileOnReturn);
    return () => {
      active = false;
      window.removeEventListener('focus', reconcileOnReturn);
      document.removeEventListener('visibilitychange', reconcileOnReturn);
    };
  }, [api]);

  async function rescan() {
    if (!api?.usage || actionBusy) return;
    setActionBusy(true);
    try { setSnapshot(await api.usage.rescan()); } finally { setActionBusy(false); }
  }

  async function toggleHooks() {
    if (!api?.codex || actionBusy) return;
    setActionBusy(true);
    try {
      const next = hookStatus?.installed ? await api.codex.uninstallHooks() : await api.codex.installHooks();
      setHookStatus(next);
    } finally { setActionBusy(false); }
  }

  const collectorDetected = Boolean(codex?.collector?.detected);
  const collectorWatching = Boolean(codex?.collector?.watching);
  const serverObserved = quotaWindows.length > 0;
  const hookInstalled = Boolean(hookStatus?.installed);
  const cachePercent = totals.inputTokens ? totals.cacheRate * 100 : 0;
  const connectedProviders = providerRows.filter((provider) => provider.integration === 'connected' || provider.measurement);

  return (
    <div className={`app-frame theme-${catTheme}`} data-update-pulse={lastUpdatePulse}>
      <div className="theme-backdrop" aria-hidden="true"><CatArt pose="backdrop" decorative /></div>
      <aside className="sidebar">
        <div className="brand"><div className="brand-paw" aria-hidden="true"><i/><i/><i/><i/></div><strong>냥토큰<br/>트래커</strong></div>
        <nav className="nav-list" aria-label="주요 메뉴">
          {navItems.map(([type, label]) => <button key={type} className={activeNav === type ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav(type)}><NavIcon type={type}/><span>{label}</span></button>)}
        </nav>
        <div className="sidebar-art" aria-hidden="true"><CatArt pose="sidebar" decorative /></div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div className="title-wrap">
            <div><h1>냥토큰 트래커</h1><p>로컬 로그와 서버 흐름을 따로 보고 함께 이해하기</p></div>
            <CatArt className="header-cat" pose="header" label={`${currentTheme.label} 쿠션 고양이 드로잉`} />
          </div>
          <div className="top-actions">
            <span className={`live-pill ${collectorDetected ? 'live-pill--real' : ''}`}><i/> {collectorDetected ? 'LIVE LOCAL' : 'WAITING CODEX'}</span>
            <button className="sync-button" type="button" onClick={rescan} disabled={!api?.usage || actionBusy}>{actionBusy ? '확인 중…' : '지금 동기화'}</button>
            <div className="skin-control">
              <button className="skin-trigger" type="button" aria-haspopup="dialog" aria-expanded={skinOpen} onClick={() => setSkinOpen((value) => !value)}><CatArt pose="face" decorative /><span><small>CAT SKIN</small><strong>{currentTheme.label}</strong></span><b aria-hidden="true">⌄</b></button>
              {skinOpen && <div className="skin-picker" role="dialog" aria-label="고양이 스킨 선택">
                <div className="skin-picker-head"><strong>오늘은 어떤 냥이?</strong><button type="button" onClick={() => setSkinOpen(false)} aria-label="스킨 선택 닫기">×</button></div>
                <div className="skin-grid">{catThemes.map((theme) => <button type="button" key={theme.id} className={`skin-option${catTheme === theme.id ? ' selected' : ''}`} aria-pressed={catTheme === theme.id} onClick={() => { setCatTheme(theme.id); setSkinOpen(false); }}><span className={`skin-cat theme-${theme.id}`}><CatArt pose="face" decorative /></span><span><strong>{theme.label}</strong><small>{theme.hint}</small></span><i aria-hidden="true">✓</i></button>)}</div>
                <p>선택한 스킨은 다음 실행에도 기억해둘게요.</p>
              </div>}
            </div>
          </div>
        </header>

        <section className="collector-strip" aria-label="Codex 수집 상태">
          <div className={`collector-chip ${collectorDetected ? 'ok' : 'wait'}`}><span>로그</span><strong>{collectorDetected ? 'Codex 발견' : '미발견'}</strong></div>
          <div className={`collector-chip ${collectorWatching ? 'ok' : 'wait'}`}><span>실시간</span><strong>{collectorWatching ? '파일 감시 중' : 'reconcile 대기'}</strong></div>
          <div className={`collector-chip ${serverObserved ? 'server' : 'wait'}`}><span>서버</span><strong>{serverObserved ? '한도 snapshot' : 'snapshot 대기'}</strong></div>
          <div className={`collector-chip ${hookInstalled ? 'ok' : 'wait'}`}><span>Hook</span><strong>{hookInstalled ? '보조 신호 연결' : '선택 설치'}</strong></div>
          <button type="button" className="hook-button" onClick={toggleHooks} disabled={!api?.codex || actionBusy}>{hookInstalled ? 'Stop Hook 해제' : '실시간 Hook 설치'}</button>
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
      </main>
    </div>
  );
}

export default App;
