import { useEffect, useMemo, useState } from 'react';
import { TableHead, ViewHead, sortRows, useSlowStamp, useTableSort } from './Bits.jsx';
import { providerCatalog, formatTokens, formatPercent, relativeTime, PENDING_LABEL } from '../shared.js';

const SESSION_COLUMNS = [
  { key: 'sessionId', label: '세션', type: 'text' },
  { key: 'model', label: '모델', type: 'text' },
  { key: 'totalTokens', label: '토큰', type: 'number' },
  { key: 'lastActivity', label: '시각', type: 'time' },
];
const sessionColumnTemplate = '1.2fr 1fr .7fr .7fr';

export default function ProjectView({ snapshot, api, focus, pending = false, onNavigate }) {
  const [projects, setProjects] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);
  const [query, setQuery] = useState('');
  const [aliasDraft, setAliasDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // 기본은 이번 달입니다(빈 상태 문구도 그렇게 적혀 있습니다). 세션 흐름에서
  // 넘어오거나 사용자가 칩을 누르면 전체 기간으로 넓힙니다.
  const [allTime, setAllTime] = useState(false);

  // 같은 이유로 느린 시계를 씁니다(Bits.jsx 의 useSlowStamp 주석 참고).
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);

  // 세션 흐름 화면에서 "프로젝트 →" 로 넘어오면 그 프로젝트가 이미 선택된
  // 상태로 열립니다. 그리고 기간을 전체로 넓힙니다 — 세션 흐름은 전체 기간을
  // 보여줄 수 있으므로, 이번 달 창으로 좁힌 채 넘어오면 넘어온 프로젝트가
  // 목록에 없는 일이 흔합니다(실측: 전체 기간 프로젝트 230개 vs 이번 달 30개).
  useEffect(() => {
    if (!focus?.projectKey) return;
    setSelectedKey(focus.projectKey);
    setAllTime(true);
  }, [focus?.projectKey]);

  useEffect(() => {
    if (!api?.projects?.list) return undefined;
    let active = true;
    // all 플래그가 없으면 서버가 이번 달로 되돌립니다(api-server.mjs 의 #since).
    // 전체 기간에서는 목록이 길어지므로 상한도 함께 올립니다 — 기본 100 이면
    // 230개 중 130개가 잘려 나가고, 그러면 넘어온 프로젝트가 또 사라집니다.
    api.projects.list(allTime ? { all: 1, limit: 500 } : {})
      .then((payload) => { if (active) setProjects(payload.projects ?? []); })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [api, stamp, allTime]);

  const list = projects ?? [];
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter((project) => `${project.name} ${project.cwd ?? ''}`.toLowerCase().includes(keyword));
  }, [list, query]);

  // 넘어온 프로젝트는 **반드시 그 프로젝트**여야 합니다. 목록에 없다고 다른
  // 프로젝트로 갈아치우면 화면이 남의 프로젝트를 이 프로젝트라고 말하고,
  // 별칭 저장·경로 가림 버튼도 그쪽에 걸립니다 — 표시 오류가 아니라 잘못된
  // 쓰기입니다. 목록에 없으면 대체하지 않고 아래에서 "찾지 못했다"고 적습니다.
  const activeKey = focus?.projectKey
    ? focus.projectKey
    : filtered.some((project) => project.projectKey === selectedKey)
      ? selectedKey
      : filtered[0]?.projectKey ?? null;
  const focusMissing = Boolean(focus?.projectKey) && projects !== null
    && !list.some((project) => project.projectKey === focus.projectKey);

  useEffect(() => {
    if (!api?.projects?.detail || !activeKey) { setDetail(null); return undefined; }
    let active = true;
    api.projects.detail(activeKey, allTime ? { all: 1 } : {})
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setAliasDraft(payload?.project?.alias ?? '');
      })
      .catch(() => { if (active) setDetail(null); });
    return () => { active = false; };
  }, [api, activeKey, stamp, allTime]);

  async function saveAlias(nextRedacted) {
    if (!api?.projects?.setAlias || !detail?.project || busy) return;
    setBusy(true);
    try {
      await api.projects.setAlias(activeKey, {
        provider: detail.project.provider,
        alias: aliasDraft,
        redacted: nextRedacted,
      });
      const refreshed = await api.projects.list(allTime ? { all: 1, limit: 500 } : {});
      setProjects(refreshed.projects ?? []);
      setDetail(await api.projects.detail(activeKey, allTime ? { all: 1 } : {}));
    } finally {
      setBusy(false);
    }
  }

  const project = detail?.project ?? null;
  const providerMeta = project ? providerCatalog.find((item) => item.id === project.provider) : null;
  const [sessionSort, toggleSessionSort] = useTableSort(SESSION_COLUMNS, 'lastActivity');
  const sortedSessions = useMemo(
    () => sortRows(detail?.sessions ?? [], SESSION_COLUMNS, sessionSort),
    [detail, sessionSort],
  );

  return (
    <>
      <ViewHead
        title="프로젝트"
        subtitle={`cwd 기준 자동 귀속 · 경로 가림은 서버에서 적용됩니다 · ${allTime ? '전체 기간' : '이번 달'}`}
      >
        <button
          type="button"
          className={`chip-button ${allTime ? 'primary' : ''}`}
          onClick={() => setAllTime((value) => !value)}
        >{allTime ? '전체 기간' : '이번 달'}</button>
        <button
          type="button"
          className="chip-button"
          disabled={!activeKey}
          onClick={() => onNavigate?.('session', { projectKey: activeKey })}
        >세션 흐름 보기 →</button>
      </ViewHead>

      {/* 넘어온 프로젝트를 못 찾았으면 그렇게 적습니다. 예전에는 이번 달 목록의
          1위 프로젝트로 조용히 갈아치웠고, 별칭·가림 버튼까지 그쪽에 걸렸습니다. */}
      {focusMissing ? (
        <section className="panel">
          <div className="empty-projects">
            <strong>넘어온 프로젝트를 이 기간 목록에서 찾지 못했어요.</strong>
            <span>
              {allTime
                ? '전체 기간에도 없습니다 — 기록이 지워졌거나 다른 provider 의 것일 수 있어요.'
                : '기간을 전체로 넓히면 나타날 수 있어요.'}
              {' 다른 프로젝트를 대신 열지는 않습니다.'}
            </span>
          </div>
        </section>
      ) : null}

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
                    <TableHead columns={SESSION_COLUMNS} sort={sessionSort} onSort={toggleSessionSort} style={{ gridTemplateColumns: sessionColumnTemplate }} />
                    {sortedSessions.map((session) => (
                      <div className="table-row" role="row" key={session.sessionId} style={{ gridTemplateColumns: sessionColumnTemplate }}>
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
          {/* 스캔 중이면 "기록이 없다"가 아니라 "아직 안 왔다" 입니다. */}
          {pending
            ? <div className="empty-projects"><strong>{PENDING_LABEL}</strong><span>로그를 읽는 중이에요. 프로젝트가 확인되는 대로 목록이 채워집니다.</span></div>
            : <div className="empty-projects"><strong>아직 이번 달 프로젝트 기록이 없어요.</strong><span>연결된 provider 로그가 발견되면 cwd 기준으로 자동 분류합니다.</span></div>}
        </section>
      )}
    </>
  );
}
