import { useEffect, useMemo, useState } from 'react';
import CatArt from './CatArt.jsx';
import { createUsageClient } from './usage-client.js';
import { catThemes, measurementPending } from './shared.js';
import DashboardView from './views/DashboardView.jsx';
import UsageView from './views/UsageView.jsx';
import ProjectView from './views/ProjectView.jsx';
import SessionView from './views/SessionView.jsx';
import BudgetView from './views/BudgetView.jsx';
import AlertView from './views/AlertView.jsx';
import SettingsView from './views/SettingsView.jsx';

const navItems = [
  ['dashboard', '대시보드'], ['usage', 'AI 사용량'], ['session', '세션 흐름'], ['project', '프로젝트'], ['budget', '동기화'], ['alert', '알림'], ['settings', '설정'],
];

function NavIcon({ type }) {
  const paths = {
    dashboard: <><path d="M4 19V9h3v10M10.5 19V5h3v14M17 19v-7h3v7"/><path d="M3 21h18"/></>,
    usage: <><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A8.5 8.5 0 0 1 20.5 9H15z"/></>,
    session: <><path d="M4 18l4-7 4 4 4-9 4 6"/><path d="M3 21h18"/></>,
    project: <><path d="M3 7h7l2 2h9v10H3z"/><path d="M3 7V5h7l2 2"/></>,
    budget: <><circle cx="12" cy="12" r="8"/><path d="M7 12h10M12 7v10"/></>,
    alert: <><path d="M6 17h12l-1.5-2.3V10a4.5 4.5 0 0 0-9 0v4.7z"/><path d="M10 20h4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.5 1a8 8 0 0 0-1.8-1L14.2 3h-4.4l-.4 3a8 8 0 0 0-1.8 1L5.1 6 3 9.4 5.1 11a7 7 0 0 0 0 2L3 14.6 5.1 18l2.5-1a8 8 0 0 0 1.8 1l.4 3h4.4l.4-3a8 8 0 0 0 1.8-1l2.5 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[type]}</svg>;
}

// hook 가속 경로를 지원하는 provider. 어댑터가 생길 땐 여기에 더합니다.
const HOOK_PROVIDERS = ['codex', 'claude'];

function App() {
  // 화면 이동은 view 와 함게 **포커스 인자**를 나릅니다. URL 을 쓰지 않는
  // 이유는 프로젝트 경로가 붌라우저 하이스토리에 남는 것을 피하기 위해서입니다
  // (docs/dev/menus/session.md).
  const [nav, setNav] = useState({ view: 'dashboard', focus: null });
  const activeNav = nav.view;
  const [skinOpen, setSkinOpen] = useState(false);
  const [catTheme, setCatTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('nyangtracker-cat-theme');
    return catThemes.some((theme) => theme.id === savedTheme) ? savedTheme : 'black';
  });
  const [snapshot, setSnapshot] = useState(null);
  // hook 설정 파일은 provider 마다 다릅니다. 상황도 provider 당 하나입니다.
  const [hookStatuses, setHookStatuses] = useState({});
  const [actionBusy, setActionBusy] = useState(false);
  const [lastUpdatePulse, setLastUpdatePulse] = useState(0);

  const api = useMemo(() => createUsageClient(window.__NYANG_TRACKER_CONFIG__), []);
  const currentTheme = catThemes.find((theme) => theme.id === catTheme) || catThemes[0];
  // provider 하나를 지목하면 안 됩니다 — Claude 만 수집 중인데 "WAITING CODEX" 는 거짓입니다.
  const collectingProviders = (snapshot?.providers ?? []).filter((item) => item.collector?.detected);
  const collectorDetected = collectingProviders.length > 0;
  // 첫 스캔이 끝나기 전의 합계는 **부분값**입니다. 화면이 이걸 그냥 보여주면
  // 사용자는 "내 사용량이 이만큼"으로 읽습니다. 그래서 스캔 중이라는 사실을
  // 숫자 위에 먼저 적습니다.
  const warmup = snapshot?.warmup ?? null;
  const scanning = warmup?.phase === 'scanning';
  const warmupVisible = scanning || warmup?.phase === 'failed';
  const scanPercent = warmup?.filesTotal
    ? Math.min(100, Math.round((warmup.filesDone / warmup.filesTotal) * 100))
    : 0;
  // 측정값이 아직 하나도 안 온 동안에는 숫자 자리에 '로딩중..' 을 넣습니다.
  // UI 틀 자체는 이 값과 무관하게 즉시 그려집니다 — 뼈대를 기다리게 하면
  // 서버가 포트를 먼저 연 이점이 화면에서 사라집니다.
  const pending = measurementPending(snapshot);

  useEffect(() => {
    window.localStorage.setItem('nyangtracker-cat-theme', catTheme);
    document.body.dataset.catTheme = catTheme;
  }, [catTheme]);

  useEffect(() => {
    if (!api?.usage) return undefined;
    let active = true;
    api.usage.getSnapshot().then((value) => { if (active) setSnapshot(value); }).catch(() => {});
    for (const providerId of HOOK_PROVIDERS) {
      api.hooks?.(providerId).getHookStatus()
        .then((value) => { if (active) setHookStatuses((current) => ({ ...current, [providerId]: value })); })
        .catch(() => {});
    }
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

  async function toggleHooks(providerId = 'codex') {
    const hooks = api?.hooks?.(providerId);
    if (!hooks || actionBusy) return;
    setActionBusy(true);
    try {
      const next = hookStatuses[providerId]?.installed ? await hooks.uninstallHooks() : await hooks.installHooks();
      setHookStatuses((current) => ({ ...current, [providerId]: next }));
    } finally { setActionBusy(false); }
  }

  // 화면 간 이동. 세션 흐름 ↔ 프로젝트를 양방향으로 오가며,
  // 가려간 화면이 그 대상을 이미 골람 상태로 열립니다.
  function navigate(view, focus = null) {
    setNav({ view, focus });
  }

  const viewProps = {
    // 대시보드도 동기화 화면과 같은 provider 별 상태를 그대로 읽습니다.
    // hookStatuses.codex 하나만 골라 넘기면 M3 부터 있던 Claude hook 이 대시보드
    // 에서만 사라지고, 칩의 'Hook 연결' 이 누구 이야기인지 알 수 없게 됩니다.
    snapshot, hookStatuses, api, actionBusy, currentTheme, pending,
    onToggleHooks: toggleHooks,
    onRescan: rescan,
  };
  const views = {
    dashboard: <DashboardView {...viewProps} />,
    usage: <UsageView snapshot={snapshot} api={api} pending={pending} />,
    session: <SessionView snapshot={snapshot} api={api} pending={pending} focus={nav.focus} onNavigate={navigate} />,
    project: <ProjectView snapshot={snapshot} api={api} pending={pending} focus={nav.focus} onNavigate={navigate} />,
    budget: <BudgetView {...viewProps} />,
    alert: <AlertView />,
    settings: <SettingsView snapshot={snapshot} catTheme={catTheme} onSelectTheme={setCatTheme} />,
  };

  return (
    <div className={`app-frame theme-${catTheme}`} data-update-pulse={lastUpdatePulse}>
      <div className="theme-backdrop" aria-hidden="true"><CatArt pose="backdrop" decorative /></div>
      <aside className="sidebar">
        <div className="brand"><div className="brand-paw" aria-hidden="true"><i/><i/><i/><i/></div><strong>냥토큰<br/>트래커</strong></div>
        <nav className="nav-list" aria-label="주요 메뉴">
          {navItems.map(([type, label]) => <button key={type} className={activeNav === type ? 'nav-item active' : 'nav-item'} onClick={() => setNav({ view: type, focus: null })}><NavIcon type={type}/><span>{label}</span></button>)}
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
            <span className={`live-pill ${collectorDetected ? 'live-pill--real' : ''}${scanning ? ' live-pill--scanning' : ''}`}><i/> {scanning ? 'SCANNING LOGS' : collectorDetected ? 'LIVE LOCAL' : 'WAITING LOGS'}</span>
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

        {warmupVisible && (
          <div className={`warmup-strip${warmup.phase === 'failed' ? ' warmup-strip--failed' : ''}`} role="status" aria-live="polite">
            <div className="warmup-copy">
              <strong>{warmup.phase === 'failed' ? '로그를 다 읽지 못했어요' : '로그를 읽고 있어요'}</strong>
              <span>{warmup.phase === 'failed'
                ? `아래 숫자는 읽어낸 로그까지만 반영합니다${warmup.error ? ` — ${warmup.error}` : ''}`
                : '아래 숫자는 아직 전체가 아닙니다. 다 읽으면 저절로 채워져요.'}</span>
            </div>
            {warmup.filesTotal > 0 && (
              <div className="warmup-meter">
                <div className="warmup-track"><i style={{ width: `${scanPercent}%` }} /></div>
                <small>파일 {warmup.filesDone.toLocaleString()}/{warmup.filesTotal.toLocaleString()}{warmup.workers ? ` · 워커 ${warmup.workers}개` : ''}</small>
              </div>
            )}
          </div>
        )}

        {views[activeNav] ?? views.dashboard}
      </main>
    </div>
  );
}

export default App;
