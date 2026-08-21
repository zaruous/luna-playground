import { useEffect, useMemo, useState } from 'react';
import { ViewHead, useSlowStamp } from './Bits.jsx';
import { providerCatalog, formatTokens, formatPercent, relativeTime } from '../shared.js';

export default function ProjectView({ snapshot, api, focus, onNavigate }) {
  const [projects, setProjects] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);
  const [query, setQuery] = useState('');
  const [aliasDraft, setAliasDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // 같은 이유로 느린 시계를 씁니다(Bits.jsx 의 useSlowStamp 주석 참고).
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);

  // 세션 흐름 화면에서 "프로젝트 →" 로 넘어오면 그 프로젝트가 이미
  // 선택된 상태로 열립니다.
  useEffect(() => {
    if (focus?.projectKey) setSelectedKey(focus.projectKey);
  }, [focus?.projectKey]);

  useEffect(() => {
    if (!api?.projects?.list) return undefined;
    let active = true;
    api.projects.list().then((payload) => { if (active) setProjects(payload.projects ?? []); }).catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [api, stamp]);

  const list = projects ?? [];
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter((project) => `${project.name} ${project.cwd ?? ''}`.toLowerCase().includes(keyword));
  }, [list, query]);

  const activeKey = filtered.some((project) => project.projectKey === selectedKey) ? selectedKey : filtered[0]?.projectKey ?? null;

  useEffect(() => {
    if (!api?.projects?.detail || !activeKey) { setDetail(null); return undefined; }
    let active = true;
    api.projects.detail(activeKey)
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setAliasDraft(payload?.project?.alias ?? '');
      })
      .catch(() => { if (active) setDetail(null); });
    return () => { active = false; };
  }, [api, activeKey, stamp]);

  async function saveAlias(nextRedacted) {
    if (!api?.projects?.setAlias || !detail?.project || busy) return;
    setBusy(true);
    try {
      await api.projects.setAlias(activeKey, {
        provider: detail.project.provider,
        alias: aliasDraft,
        redacted: nextRedacted,
      });
      const refreshed = await api.projects.list();
      setProjects(refreshed.projects ?? []);
      setDetail(await api.projects.detail(activeKey));
    } finally {
      setBusy(false);
    }
  }

  const project = detail?.project ?? null;
  const providerMeta = project ? providerCatalog.find((item) => item.id === project.provider) : null;

  return (
    <>
      <ViewHead title="프로젝트" subtitle="cwd 기준 자동 귀속 · 경로 가림은 서버에서 적용됩니다">
        <button
          type="button"
          className="chip-button"
          disabled={!activeKey}
          onClick={() => onNavigate?.('session', { projectKey: activeKey })}
        >세션 흐름 보기 →</button>
      </ViewHead>

      {list.length ? (
        <div className="project-layout">
          <section className="panel project-list-panel">
            <input className="search-input" type="search" placeholder="프로젝트 검색" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="프로젝트 검색" />
            <div className="project-list">
              {filtered.map((item) => (
                <button type="button" key={item.projectKey} className={`project-item${item.projectKey === activeKey ? ' selected' : ''}`} onClick={() => setSelectedKey(item.projectKey)}>
                  <strong>{item.name}{item.redacted ? ' 🔒' : ''}</strong>
                  <small>{formatTokens(item.totalTokens)} · {providerCatalog.find((meta) => meta.id === item.provider)?.name ?? item.provider}</small>
                </button>
              ))}
              {!filtered.length && <p className="filter-note">검색 결과가 없어요.</p>}
            </div>
            <p className="filter-note">Cursor는 Admin API가 프로젝트 정보를 주지 않아 이 목록에 나타나지 않습니다.</p>
          </section>

          <div className="view-stack">
            {project ? (
              <>
                <section className="panel">
                  <div className="panel-head">
                    <div><h2>{project.name} <span>••</span></h2><p className="panel-sub">{project.redacted ? '경로 가림 — 원본은 로컬 SQLite에만 남습니다' : project.cwd || '경로 메타데이터 없음'}</p></div>
                    {providerMeta ? <span className={`ai-mark ${providerMeta.tone}`}>{providerMeta.short}</span> : null}
                  </div>
                  <div className="stat-mini-grid">
                    <div className="stat-mini"><span>총 토큰</span><strong>{formatTokens(project.totalTokens)}</strong></div>
                    <div className="stat-mini"><span>세션</span><strong className="mint-text">{project.sessionCount}</strong></div>
                    <div className="stat-mini"><span>모델</span><strong className="violet-text">{project.modelCount}종</strong></div>
                    <div className="stat-mini"><span>최근 활동</span><strong className="orange-text">{relativeTime(project.lastActivity)}</strong></div>
                  </div>
                  <div className="alias-row">
                    <input className="search-input" type="text" value={aliasDraft} placeholder="표시할 별칭 (선택)" onChange={(event) => setAliasDraft(event.target.value)} aria-label="프로젝트 별칭" />
                    <button type="button" className="chip-button" onClick={() => saveAlias(project.redacted)} disabled={busy}>별칭 저장</button>
                    <button type="button" className={`chip-button ${project.redacted ? 'primary' : ''}`} onClick={() => saveAlias(!project.redacted)} disabled={busy}>
                      {project.redacted ? '가림 해제' : '경로 가림'}
                    </button>
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head"><div><h2>모델 분포 <span>••</span></h2></div></div>
                  <div className="gauge-list">
                    {detail.models.map((item) => (
                      <div className="model-row" key={item.model}>
                        <div className="model-copy"><span>{item.model}</span><strong>{formatTokens(item.tokens.totalTokens)}</strong><small>{formatPercent(item.share * 100, 1)}</small></div>
                        <div className="quota-track"><i style={{ width: `${item.share * 100}%` }} /></div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="panel">
                  <div className="panel-head"><div><h2>세션 <span>••</span></h2><p className="panel-sub">최근 {detail.sessions.length}개</p></div></div>
                  <div className="project-table" role="table">
                    <div className="table-row table-head" role="row" style={{ gridTemplateColumns: '1.2fr 1fr .7fr .7fr' }}>
                      <span>세션</span><span>모델</span><span>토큰</span><span>시각</span>
                    </div>
                    {detail.sessions.map((session) => (
                      <div className="table-row" role="row" key={session.sessionId} style={{ gridTemplateColumns: '1.2fr 1fr .7fr .7fr' }}>
                        <strong>{String(session.sessionId).slice(0, 8)}…{String(session.sessionId).slice(-4)}</strong>
                        <span>{session.model ?? '—'}</span>
                        <span>{formatTokens(session.totalTokens)}</span>
                        <span>{relativeTime(session.lastActivity)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <section className="panel"><div className="empty-projects"><strong>프로젝트를 선택하세요.</strong><span>왼쪽 목록에서 하나를 고르면 상세가 나타납니다.</span></div></section>
            )}
          </div>
        </div>
      ) : (
        <section className="panel">
          <div className="empty-projects"><strong>아직 이번 달 프로젝트 기록이 없어요.</strong><span>연결된 provider 로그가 발견되면 cwd 기준으로 자동 분류합니다.</span></div>
        </section>
      )}
    </>
  );
}
