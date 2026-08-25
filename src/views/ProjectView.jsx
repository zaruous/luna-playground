import { useEffect, useMemo, useState } from 'react';
import { TableHead, ViewHead, sortRows, useSlowStamp, useTableSort } from './Bits.jsx';
import { SessionTurnAnalysis } from './SessionTurns.jsx';
import { resolveActiveProject } from '../project-focus.js';
import { providerCatalog, formatTokens, formatPercent, relativeTime, PENDING_LABEL } from '../shared.js';

// '상세' 는 정렬할 값이 없는 손잡이 칸입니다 — 세션 흐름의 비싼 턴 표와 같은
// 방식으로, 줄을 누르면 그 세션의 턴 분석이 바로 아래로 펼쳐집니다.
const SESSION_COLUMNS = [
  { key: 'sessionId', label: '세션', type: 'text' },
  { key: 'model', label: '모델', type: 'text' },
  { key: 'totalTokens', label: '토큰', type: 'number' },
  { key: 'lastActivity', label: '시각', type: 'time' },
  { key: 'detail', label: '상세', sortable: false },
];
const sessionColumnTemplate = '1.1fr .9fr .6fr .6fr .4fr';

// 왼쪽 프로젝트 목록도 대시보드 "최근 프로젝트 발자국"과 같은 기준(마지막
// 활동 내림차순)으로 보여줍니다. 서버가 내려주는 기본 순서(getProjectBreakdown,
// 토큰 총량 내림차순)를 그대로 쓰면 두 화면이 "최근"이라는 같은 말을 다른
// 순서로 말하게 됩니다 — 여기서 클라이언트가 다시 정렬합니다.
const PROJECT_LIST_SORT_COLUMNS = [{ key: 'lastActivity', type: 'time' }];
const PROJECT_LIST_SORT = { key: 'lastActivity', direction: 'desc' };

export default function ProjectView({ snapshot, api, focus, pending = false, onNavigate }) {
  const [projects, setProjects] = useState(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [detail, setDetail] = useState(null);
  const [query, setQuery] = useState('');
  const [aliasDraft, setAliasDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // 펼친 세션. 턴 분석은 원장을 다시 읽고, 그 안의 턴 상세는 원본 파일까지
  // 다시 읽는 무거운 호출이라 한 번에 하나만 엽니다(세션 흐름 화면과 같은 규칙).
  const [openSession, setOpenSession] = useState(null);
  // 넘어온 프로젝트 이름을 아직 검색 칸에 못 옮긴 상태. 이름은 목록이 도착한
  // 뒤에 읽습니다 — 별칭·가림·'(미분류)' 때문에 세션 화면의 이름과 프로젝트
  // 목록의 이름이 다를 수 있고, 안 맞는 이름을 걸면 목록이 텅 빕니다.
  const [pendingFocusQuery, setPendingFocusQuery] = useState(null);
  // 기본은 이번 달입니다(빈 상태 문구도 그렇게 적혀 있습니다). 세션 흐름에서
  // 넘어오거나 사용자가 칩을 누르면 전체 기간으로 넓힙니다.
  const [allTime, setAllTime] = useState(false);

  // 같은 이유로 느린 시계를 씁니다(Bits.jsx 의 useSlowStamp 주석 참고).
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);

  // 세션 흐름 화면에서 "프로젝트 →" 로 넘어오면 그 프로젝트가 이미 선택된
  // 상태로 열립니다. 그리고 기간을 전체로 넓힙니다 — 세션 흐름은 전체 기간을
  // 보여줄 수 있으므로, 이번 달 창으로 좁힌 채 넘어오면 넘어온 프로젝트가
  // 목록에 없는 일이 흔합니다(실측: 전체 기간 프로젝트 230개 vs 이번 달 30개).
  //
  // 선택을 **잠그지는 않습니다.** 예전에는 넘어온 키를 activeKey 로 못 박아
  // 다른 프로젝트를 눌러도 화면이 바뀌지 않았습니다. 대신 그 프로젝트 이름을
  // 검색 칸에 걸어 목록을 좁힙니다 — 같은 프로젝트를 바로 보여 주면서도
  // 검색어를 지우면 전체 목록으로 돌아갈 수 있습니다.
  useEffect(() => {
    if (!focus?.projectKey) return;
    setSelectedKey(focus.projectKey);
    setAllTime(true);
    setPendingFocusQuery(focus.projectKey);
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

  const list = useMemo(
    () => sortRows(projects ?? [], PROJECT_LIST_SORT_COLUMNS, PROJECT_LIST_SORT),
    [projects],
  );
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return list;
    return list.filter((project) => `${project.name} ${project.cwd ?? ''}`.toLowerCase().includes(keyword));
  }, [list, query]);

  // 넘어온 프로젝트가 목록에 들어오는 순간 그 **목록의 이름**을 검색 칸에
  // 옮겨 적습니다. 세션 화면이 넘겨 준 이름을 그대로 쓰지 않는 이유는 두
  // 화면의 이름이 갈릴 수 있기 때문입니다 — 프로젝트가 없는 세션은 세션
  // 화면에서 'unknown-project', 프로젝트 목록에서 '(미분류)' 입니다.
  useEffect(() => {
    if (!pendingFocusQuery || projects === null) return;
    const match = list.find((project) => project.projectKey === pendingFocusQuery);
    // 목록에 없으면 검색어를 걸지 않습니다 — 아무것도 안 걸리는 검색어를
    // 남기면 "찾지 못했다" 안내 옆에서 목록까지 텅 빕니다.
    if (match) setQuery(match.name);
    setPendingFocusQuery(null);
  }, [pendingFocusQuery, projects, list]);

  // 고른 프로젝트가 목록에 없으면 다른 프로젝트로 갈아치우지 않습니다 —
  // 별칭 저장·경로 가림 버튼이 열린 프로젝트에 걸리므로, 조용한 대체는 표시
  // 오류가 아니라 잘못된 쓰기입니다(규칙 자체는 project-focus.js).
  const { activeKey, missing } = useMemo(
    () => resolveActiveProject({ list, filtered, selectedKey }),
    [list, filtered, selectedKey],
  );
  const selectionMissing = missing && projects !== null;
  const focusMissing = selectionMissing && selectedKey === focus?.projectKey;

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

  // 프로젝트를 바꾸면 펼친 세션을 닫습니다 — 세션 id 는 프로젝트마다 다른
  // 목록이라, 그대로 두면 다른 프로젝트의 줄이 열려 있는 것처럼 보입니다.
  useEffect(() => { setOpenSession(null); }, [activeKey]);

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

      {/* 고른 프로젝트를 못 찾았으면 그렇게 적습니다. 예전에는 이번 달 목록의
          1위 프로젝트로 조용히 갈아치웠고, 별칭·가림 버튼까지 그쪽에 걸렸습니다. */}
      {selectionMissing ? (
        <section className="panel">
          <div className="empty-projects">
            <strong>
              {focusMissing
                ? '넘어온 프로젝트를 이 기간 목록에서 찾지 못했어요.'
                : '고른 프로젝트가 이 기간 목록에 없어요.'}
            </strong>
            <span>
              {allTime
                ? '전체 기간에도 없습니다 — 기록이 지워졌거나 다른 provider 의 것일 수 있어요.'
                : '기간을 전체로 넓히면 나타날 수 있어요.'}
              {' 다른 프로젝트를 대신 열지는 않습니다 — 왼쪽 목록에서 직접 고르면 그 프로젝트가 열립니다.'}
            </span>
          </div>
        </section>
      ) : null}

      {list.length ? (
        <div className="project-layout">
          <section className="panel project-list-panel">
            <div className="project-search">
              <input className="search-input" type="search" placeholder="프로젝트 검색" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="프로젝트 검색" />
              {query ? (
                <button type="button" className="chip-button tiny" onClick={() => setQuery('')}>검색 지우기</button>
              ) : null}
            </div>
            {/* 세션 흐름에서 넘어오면 이 칸에 그 프로젝트 이름이 걸립니다.
                선택은 잠기지 않으므로, 지우면 전체 목록에서 아무 프로젝트나
                고를 수 있다는 사실을 적어 둡니다. */}
            {query ? (
              <p className="filter-note">
                이름 필터로 {filtered.length}개 · 지우면 {list.length}개 전체가 나옵니다.
              </p>
            ) : null}
            <div className="project-list">
              {filtered.map((item) => (
                <button type="button" key={item.projectKey} className={`project-item${item.projectKey === activeKey ? ' selected' : ''}`} onClick={() => setSelectedKey(item.projectKey)}>
                  <strong>{item.name}{item.redacted ? ' 🔒' : ''}</strong>
                  {/* cwd 를 여기서도 보여주는 이유: 이름만 보면 같은 레포의
                      하위 폴더들이(예: mesclient / Client/MESClient / ...Setup)
                      서로 무관한 프로젝트처럼 보입니다 — 상세를 열어야만
                      보이던 경로를 목록에서도 바로 대조할 수 있게 합니다. */}
                  <small className="project-item-cwd" title={item.cwd ?? undefined}>{item.redacted ? '경로 가림' : (item.cwd || '경로 메타데이터 없음')}</small>
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
                  <div className="panel-head">
                    <div>
                      <h2>세션 <span>••</span></h2>
                      {/* 세션 흐름 화면의 비싼 턴과 같은 상세를 여기서도 엽니다 —
                          "이 프로젝트가 얼마를 썼나" 다음 질문은 늘 "어느 턴이
                          비쌌고 그 턴이 무엇에 썼나" 이고, 그걸 보려고 화면을
                          옮겨 다니게 하지 않습니다. */}
                      <p className="panel-sub">최근 {detail.sessions.length}개 · <strong>행을 누르면</strong> 그 세션의 비싼 턴과 턴 상세가 아래에 펼쳐집니다</p>
                    </div>
                  </div>
                  <div className="project-table" role="table">
                    <TableHead columns={SESSION_COLUMNS} sort={sessionSort} onSort={toggleSessionSort} style={{ gridTemplateColumns: sessionColumnTemplate }} />
                    {sortedSessions.map((session) => {
                      // 원장에 session_id 가 없는 묶음도 있습니다(그룹 키가 빈
                      // 값). 흐름 조회는 그런 세션을 찾을 수 없으므로 손잡이를
                      // 아예 잠급니다 — 눌러서 404 를 보게 하지 않습니다.
                      const sessionId = session.sessionId ? String(session.sessionId) : '';
                      const open = Boolean(sessionId) && openSession === sessionId;
                      const toggle = () => {
                        if (!sessionId) return;
                        setOpenSession((current) => (current === sessionId ? null : sessionId));
                      };
                      return (
                        <div key={sessionId || '(세션 미기록)'}>
                          <div
                            className={`table-row session-row ${open ? 'is-open' : ''}`}
                            role="row"
                            style={{ gridTemplateColumns: sessionColumnTemplate }}
                            onClick={toggle}
                          >
                            <strong>{sessionId ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : '(세션 미기록)'}</strong>
                            <span>{session.model ?? '—'}</span>
                            <span>{formatTokens(session.totalTokens)}</span>
                            <span>{relativeTime(session.lastActivity)}</span>
                            <span>
                              <button
                                type="button"
                                className="chip-button tiny"
                                disabled={!sessionId}
                                aria-expanded={sessionId ? open : undefined}
                                aria-label={`세션 ${sessionId.slice(0, 8)} 상세 ${open ? '접기' : '펼치기'}`}
                                onClick={(event) => { event.stopPropagation(); toggle(); }}
                              >{open ? '▾' : '▸'}</button>
                            </span>
                          </div>
                          {open ? (
                            <SessionTurnAnalysis
                              api={api}
                              // 프로젝트 세션 표에는 provider 칸이 없습니다 —
                              // 프로젝트가 provider 단위로 갈리므로 프로젝트의
                              // provider 가 곧 이 세션의 provider 입니다.
                              session={{ sessionId, provider: project.provider, projectName: project.name }}
                              stamp={stamp}
                              onOpenFlow={() => onNavigate?.('session', { projectKey: activeKey })}
                            />
                          ) : null}
                        </div>
                      );
                    })}
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
