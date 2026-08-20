import { useEffect, useMemo, useState } from 'react';
import CatArt from './CatArt.jsx';
import { createUsageClient } from './usage-client.js';
import { catThemes } from './shared.js';
import DashboardView from './views/DashboardView.jsx';
import UsageView from './views/UsageView.jsx';
import ProjectView from './views/ProjectView.jsx';
import BudgetView from './views/BudgetView.jsx';
import AlertView from './views/AlertView.jsx';
import SettingsView from './views/SettingsView.jsx';

const navItems = [
  ['dashboard', '대시보드'], ['usage', 'AI 사용량'], ['project', '프로젝트'], ['budget', '동기화'], ['alert', '알림'], ['settings', '설정'],
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
  const collectorDetected = Boolean(snapshot?.providers?.find((item) => item.id === 'codex')?.collector?.detected);

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

  const viewProps = { snapshot, hookStatus, api, actionBusy, currentTheme, onToggleHooks: toggleHooks, onRescan: rescan };
  const views = {
    dashboard: <DashboardView {...viewProps} />,
    usage: <UsageView snapshot={snapshot} />,
    project: <ProjectView snapshot={snapshot} />,
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

        {views[activeNav] ?? views.dashboard}
      </main>
    </div>
  );
}

export default App;
