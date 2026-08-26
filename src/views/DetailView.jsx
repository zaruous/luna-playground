import { useEffect, useMemo, useState } from 'react';
import { TableHead, ViewHead, sortRows, useSlowStamp, useTableSort } from './Bits.jsx';
import ToolContentModal from './ToolContentModal.jsx';
import { formatTokens, formatPercent, relativeTime, qualityLabels, PENDING_LABEL, cursorContextText } from '../shared.js';

// 상세 내역 — 프로젝트(cwd) → 세션 → 도구, 토큰량 중심.
//
// 세 계층을 내려가며 "뭐가 많았나" 에 답하고, 많이 쓴 도구의 [보기] 로 "왜"
// 까지 사람이 직접 확인합니다(docs/dev/menus/detail.md).
//
// 새 회계 규칙은 없습니다 — 프로젝트 귀속·세션 합계·도구 배분이 전부 기존
// 화면과 같은 서버 규칙을 재사용합니다.

// 화면이 고를 수 있는 행 수. 서버의 ROW_LIMITS 와 **같은 목록**이어야 합니다.
const ROW_LIMITS = [20, 50, 100, 1000];

// 담는 기준. 정렬(아래 컬럼 클릭)과 다른 손잡이입니다 — 이쪽은 "무엇을
// 가져올까", 저쪽은 "가져온 것을 어떻게 세울까" 입니다. 기본이 비용순인 이유는
// 이 화면의 질문이 "뭐가 많았나" 라서, 시간순으로 앞에서 자르면 정작 비싼 행이
// 상한 밖으로 밀려나기 때문입니다.
const ORDERS = [
  { id: 'cost', label: '토큰 많은 순' },
  { id: 'time', label: '시간 순' },
];

const RECORD_COLUMNS = [
  { key: 'at', label: '시각', type: 'time' },
  { key: 'turnIndex', label: '턴', type: 'number' },
  { key: 'tools', label: '도구 (호출)', sortable: false },
  { key: 'newPrompt', label: '신규 프롬프트', type: 'number', value: (row) => (row.tokens?.inputTokens ?? 0) + (row.tokens?.cacheWriteInputTokens ?? 0) },
  { key: 'cachedInputTokens', label: '캐시 읽기', type: 'number', value: (row) => row.tokens?.cachedInputTokens },
  { key: 'outputTokens', label: '출력', type: 'number', value: (row) => row.tokens?.outputTokens },
  { key: 'totalTokens', label: '합계', type: 'number', value: (row) => row.tokens?.totalTokens },
  { key: 'quality', label: '품질', sortable: false },
  { key: 'content', label: '내용', sortable: false },
];
const recordColumnTemplate = '.75fr .35fr 1.5fr .8fr .7fr .55fr .7fr .55fr .5fr';

// MCP 도구 이름은 `mcp__<서버>__<도구>` 입니다. 표에 원문을 그대로 쓰면 한 칸을
// 통째로 먹으므로 서버 ▸ 도구로 줄입니다 — 서버 이름에 밑줄이 있을 수 있어
// 구분자는 두 겹 밑줄뿐입니다(claude/turn-detail.mjs 와 같은 규칙).
export function toolLabel(name) {
  const matched = /^mcp__(.+)__([^_]+(?:_[^_]+)*)$/.exec(String(name ?? ''));
  return matched ? `${matched[1]} ▸ ${matched[2]}` : String(name ?? '');
}

// [보기] 버튼의 글자. 한 행에 호출이 여럿이면 버튼도 여럿이라, 전부 '보기'로
// 두면 어느 호출을 여는지 알 수 없습니다. MCP 는 서버까지 붙이면 버튼이 칸을
// 넘치므로 도구 조각만 씁니다 — 전체 이름은 title 로 남깁니다.
export function callButtonLabel(name) {
  const matched = /^mcp__(.+)__([^_]+(?:_[^_]+)*)$/.exec(String(name ?? ''));
  return matched ? matched[2] : String(name ?? '보기');
}

export function toolsText(tools) {
  const entries = Object.entries(tools ?? {}).filter(([, count]) => count > 0);
  if (!entries.length) return '(도구 없음 — 채팅)';
  return entries
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${toolLabel(name)} ×${count}`)
    .join(' · ');
}

function newPromptOf(row) {
  return (row.tokens?.inputTokens ?? 0) + (row.tokens?.cacheWriteInputTokens ?? 0);
}

// 도구별 토큰량 막대. 채팅·도구·MCP 만 그립니다 — 파일 가지는 도구 안에서 다시
// 센 것이라 토큰이 없고, 같은 막대에 넣으면 합이 100%를 넘습니다.
function ToolBreakdown({ breakdown }) {
  const pie = (breakdown ?? []).filter((row) => row.pie && row.tokens > 0);
  const total = pie.reduce((sum, row) => sum + row.tokens, 0);
  if (!total) {
    return <div className="empty-projects"><strong>배분할 토큰이 없어요.</strong></div>;
  }
  // 막대는 큰 범주(채팅/도구/MCP)로 긋고, 아래 목록은 **도구 하나하나**로
  // 폅니다 — "뭐가 많았나" 의 답은 보통 범주가 아니라 도구 이름입니다.
  const leaves = [];
  for (const row of pie) {
    if (row.key === 'chat') { leaves.push({ key: 'chat', label: '채팅 (도구 없는 응답)', tokens: row.tokens }); continue; }
    for (const child of row.children ?? []) {
      if (row.key === 'mcp') {
        for (const tool of child.children ?? []) {
          leaves.push({ key: `${child.key}:${tool.key}`, label: `${child.label} ▸ ${tool.label}`, tokens: tool.tokens, calls: tool.calls });
        }
        continue;
      }
      leaves.push({ key: child.key, label: child.label, tokens: child.tokens, calls: child.calls });
    }
  }
  leaves.sort((left, right) => right.tokens - left.tokens);

  return (
    <div className="tool-breakdown">
      <div className="tool-breakdown-bar" role="img" aria-label="범주별 토큰 비중">
        {pie.map((row) => (
          <i key={row.key} className={`cat-${row.key}`} style={{ width: `${(row.tokens / total) * 100}%` }} title={`${row.label} ${formatTokens(row.tokens)}`} />
        ))}
      </div>
      <div className="tool-breakdown-list">
        {leaves.slice(0, 8).map((leaf) => (
          <span key={leaf.key} className="tool-breakdown-item">
            <strong>{leaf.label}</strong>
            <b>{formatTokens(leaf.tokens)}</b>
            <small>{formatPercent((leaf.tokens / total) * 100, 1)}{leaf.calls ? ` · ${leaf.calls}회` : ''}</small>
          </span>
        ))}
      </div>
      <p className="filter-note">
        한 요청이 도구를 여럿 부르면 호출 비율로 나눕니다 — <strong>인과가 아니라 추정 배분</strong>입니다.
        어느 호출이 실제로 무엇을 가져왔는지는 행의 <strong>[보기]</strong> 로 확인합니다.
      </p>
    </div>
  );
}

const REASONS = {
  source_missing: {
    title: '원본 로그가 이미 없어요.',
    body: '상세 내역은 원본 파일을 그 자리에서 다시 읽어 만듭니다. 파일이 지워지면 남는 것은 합계뿐이에요.',
  },
  no_source: {
    title: '이 세션에 연결된 원본 파일이 없어요.',
    body: '원장에 파일 경로가 남아 있지 않은 세션입니다. 다시 스캔해도 되살아나지 않아요.',
  },
  provider_not_implemented: {
    title: '이 provider 는 상세 내역을 아직 붙이지 않았어요.',
    body: '로그 형태와 턴 경계를 실측으로 확인한 뒤에 켭니다.',
  },
  provider_has_no_turns: {
    title: '이 provider 는 원본에 대화 구조가 없어요.',
    body: 'Cursor Admin API 는 이벤트 단위 집계만 줍니다 — 펼칠 요청 행이 없습니다.',
  },
  provider_unknown: { title: '모르는 provider 예요.', body: '등록표에 없는 provider 입니다.' },
};

export default function DetailView({ snapshot, api, pending }) {
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);
  const [projects, setProjects] = useState([]);
  const [activeKey, setActiveKey] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [limit, setLimit] = useState(100);
  const [order, setOrder] = useState('cost');
  const [state, setState] = useState({ status: 'idle', detail: null, error: null });
  // 열린 도구 호출. 팝업이 닫히면 null 로 돌아가고 본문도 함께 버려집니다.
  const [openCall, setOpenCall] = useState(null);

  const [sort, toggleSort] = useTableSort(RECORD_COLUMNS, 'totalTokens');
  // Cursor 프로젝트는 요청 델타 토큰이 없어 totalTokens 가 항상 0입니다(R7 —
  // 가짜로 채우지 않음). 칩에 formatTokens(0) 을 그대로 찍으면 "쟀더니 0"으로
  // 읽히므로 대시보드와 같은 방식으로 마지막 관측 컨텍스트를 대신 보여줍니다.
  const cursorContext = snapshot?.providers?.find((provider) => provider.id === 'cursor')?.cursorContext ?? null;

  // 1층: 최근 작업 프로젝트. 기간을 좁히지 않는 이유는 "최근 작업" 이 이미
  // 정렬 기준이기 때문입니다 — 이번 달로 자르면 지난주까지 쓰던 프로젝트가
  // 목록에서 통째로 사라집니다.
  useEffect(() => {
    if (!api?.projects?.recent) return undefined;
    let active = true;
    api.projects.recent({ limit: 5, all: 1 })
      .then((payload) => {
        if (!active) return;
        const rows = payload.projects ?? [];
        setProjects(rows);
        setActiveKey((current) => (rows.some((row) => row.projectKey === current) ? current : rows[0]?.projectKey ?? null));
      })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [api, stamp]);

  // 2층: 그 프로젝트의 세션. 프로젝트를 바꾸면 고른 세션을 놓습니다 — 세션
  // id 는 프로젝트를 가로지르지 않으므로 그대로 두면 빈 표가 됩니다.
  useEffect(() => {
    if (!api?.projects?.sessions || !activeKey) { setSessions([]); return undefined; }
    let active = true;
    api.projects.sessions(activeKey, { limit: 20, all: 1 })
      .then((payload) => {
        if (!active) return;
        const rows = payload.sessions ?? [];
        setSessions(rows);
        setActiveSession((current) => {
          const kept = rows.find((row) => row.sessionId === current?.sessionId);
          return kept ?? rows[0] ?? null;
        });
      })
      .catch(() => { if (active) { setSessions([]); setActiveSession(null); } });
    return () => { active = false; };
  }, [api, activeKey, stamp]);

  // 3·4층: 도구별 토큰량 + 요청 행. 세션·행 수·담는 기준이 바뀔 때만 당깁니다 —
  // 원본을 다시 읽는 무거운 호출이라 스냅샷마다 부르지 않습니다.
  const sessionId = activeSession?.sessionId ?? null;
  const provider = activeSession?.provider ?? null;
  useEffect(() => {
    if (!api?.sessions?.records || !sessionId) { setState({ status: 'idle', detail: null, error: null }); return undefined; }
    let active = true;
    setState({ status: 'loading', detail: null, error: null });
    api.sessions.records(sessionId, { provider, limit, order })
      .then((detail) => { if (active) setState({ status: 'ready', detail, error: null }); })
      .catch((error) => { if (active) setState({ status: 'error', detail: null, error: error.message }); });
    return () => { active = false; };
  }, [api, sessionId, provider, limit, order]);

  // 세션을 바꾸면 열린 팝업을 닫습니다 — 다른 세션의 호출 내용이 떠 있는 것은
  // 거짓입니다.
  useEffect(() => { setOpenCall(null); }, [sessionId]);

  const detail = state.detail;
  const rows = useMemo(() => sortRows(detail?.records ?? [], RECORD_COLUMNS, sort), [detail, sort]);
  const activeProject = projects.find((row) => row.projectKey === activeKey) ?? null;

  return (
    <>
      <ViewHead
        title="상세 내역"
        subtitle="프로젝트(cwd) → 세션 → 도구 — 토큰이 어디로 갔는지 요청 한 줄까지 내려갑니다"
      />

      <div className="view-stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>최근 작업 프로젝트 <span>••</span></h2>
            <p className="panel-sub">cwd 로 귀속하고 <strong>마지막 활동 순</strong>으로 최대 5개 — 토큰 순이 아닙니다</p>
          </div>
        </div>
        {projects.length ? (
          <div className="chip-row">
            {projects.map((project) => (
              <button
                type="button"
                key={project.projectKey}
                className={`chip-button${project.projectKey === activeKey ? ' primary' : ''}`}
                onClick={() => setActiveKey(project.projectKey)}
              >
                {project.name}
                <small>{project.provider === 'cursor' ? (cursorContextText(cursorContext) ?? '—') : formatTokens(project.totalTokens)} · {relativeTime(project.lastActivity)}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-projects">
            <strong>{pending ? PENDING_LABEL : '아직 읽어낸 프로젝트가 없어요.'}</strong>
            <span>로그를 다 읽으면 최근 작업한 프로젝트가 여기에 뜹니다.</span>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>세션 <span>••</span></h2>
            <p className="panel-sub">
              {activeProject ? `${activeProject.name} 의 최근 세션` : '프로젝트를 먼저 고르세요'}
              {activeProject?.redacted ? ' · 가림된 프로젝트라 경로와 내용 보기가 잠깁니다' : ''}
            </p>
          </div>
        </div>
        {sessions.length ? (
          <div className="chip-row">
            {sessions.map((session) => (
              <button
                type="button"
                key={session.sessionId}
                className={`chip-button${session.sessionId === sessionId ? ' primary' : ''}`}
                onClick={() => setActiveSession(session)}
              >
                {session.sessionId.slice(0, 8)}…
                <small>{formatTokens(session.totalTokens)} · {session.requestCount.toLocaleString('ko-KR')}요청 · {relativeTime(session.lastActivity)}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-projects">
            <strong>이 프로젝트에는 세션이 없어요.</strong>
            {/* Cursor 프로젝트는 "최근 작업 프로젝트"(cursor_local_activity 기반)에는
                뜨지만, 세션 목록은 요청 단위 원장(usage_events)에서만 옵니다 —
                Cursor 는 거기 안 씁니다(docs/dev/cursor/decisions.md 결정 4).
                아무 설명 없이 비어 있으면 "곧 채워질 것"으로 읽히므로(R7) 이유를
                적습니다. */}
            {activeProject?.provider === 'cursor'
              ? <span>Cursor 는 요청 단위 세션 원장을 아직 지원하지 않습니다 — 이 프로젝트에서 관측한 컨텍스트 구성은 대시보드에서 볼 수 있어요.</span>
              : null}
          </div>
        )}
      </section>

      {state.status === 'loading' ? (
        <section className="panel"><div className="empty-projects"><strong>{PENDING_LABEL}</strong><span>원본 로그를 다시 읽는 중입니다.</span></div></section>
      ) : null}
      {state.status === 'error' ? (
        <section className="panel"><div className="empty-projects"><strong>상세 내역을 불러오지 못했어요.</strong><span>{state.error}</span></div></section>
      ) : null}

      {state.status === 'ready' && detail && !detail.available ? (
        <section className="panel">
          <div className="empty-projects">
            <strong>{(REASONS[detail.reason] ?? REASONS.provider_unknown).title}</strong>
            <span>{(REASONS[detail.reason] ?? REASONS.provider_unknown).body}</span>
          </div>
        </section>
      ) : null}

      {state.status === 'ready' && detail?.available ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>도구별 토큰량 <span>••</span></h2>
                <p className="panel-sub">
                  이 세션 전체 <strong>{formatTokens(detail.measured.totalTokens)}</strong> ·
                  요청 {detail.measured.requestCount.toLocaleString('ko-KR')}개 ·
                  도구 호출 {detail.measured.toolCalls.toLocaleString('ko-KR')}회
                </p>
              </div>
            </div>
            <ToolBreakdown breakdown={detail.toolBreakdown} />
            {detail.measured.totalTokens !== detail.ledger.totalTokens ? (
              <p className="filter-note">
                원장은 {formatTokens(detail.ledger.totalTokens)}, 파일을 다시 읽은 값은 {formatTokens(detail.measured.totalTokens)} 입니다 —
                마지막 스캔 이후 로그가 더 붙었거나, 원장이 접은 사본이 파일에는 남아 있는 경우입니다.
              </p>
            ) : null}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>요청 행 <span>••</span></h2>
                <p className="panel-sub">
                  담는 기준과 표시 정렬은 다른 손잡이입니다 — 아래 칩이 <strong>무엇을 가져올지</strong>, 표 머리가 <strong>어떻게 세울지</strong>를 정합니다
                </p>
              </div>
              <div className="panel-actions">
                {ORDERS.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`chip-button tiny${order === item.id ? ' primary' : ''}`}
                    onClick={() => setOrder(item.id)}
                  >{item.label}</button>
                ))}
                {ROW_LIMITS.map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={`chip-button tiny${limit === value ? ' primary' : ''}`}
                    onClick={() => setLimit(value)}
                  >{value}</button>
                ))}
              </div>
            </div>

            <div className="table-wrap">
              <TableHead columns={RECORD_COLUMNS} sort={sort} onSort={toggleSort} style={{ gridTemplateColumns: recordColumnTemplate }} />
              {rows.map((row) => (
                <div className="table-row" role="row" key={row.seq} style={{ gridTemplateColumns: recordColumnTemplate }}>
                  <span>{row.at ? new Date(row.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</span>
                  <span>{row.turnIndex ? row.turnIndex : '—'}</span>
                  <span className="turn-tools">{toolsText(row.tools)}{row.sidechain ? ' · 서브에이전트' : ''}</span>
                  <span>{formatTokens(newPromptOf(row))}</span>
                  <span>{formatTokens(row.tokens?.cachedInputTokens ?? 0)}</span>
                  <span>{formatTokens(row.tokens?.outputTokens ?? 0)}</span>
                  <strong>{formatTokens(row.tokens?.totalTokens ?? 0)}</strong>
                  {/* 요청 행의 품질은 **문자열 등급**입니다(이벤트 단위).
                      qualityBadge 는 필드별 내역을 담은 객체를 받으므로 여기에
                      쓰면 전부 '관측 대기'로 떨어집니다. */}
                  <span className="quality-cell">{qualityLabels[row.measurementQuality]?.label ?? '—'}</span>
                  <span className="record-content-cell">
                    {(row.toolCalls ?? []).length && !detail.redacted ? (
                      (row.toolCalls ?? []).map((call) => (
                        <button
                          type="button"
                          key={call.id}
                          className="chip-button tiny"
                          title={`${toolLabel(call.tool)} 호출 내용 보기`}
                          onClick={() => setOpenCall({ ...call, sessionId, provider })}
                        >{callButtonLabel(call.tool)}</button>
                      ))
                    ) : <em>—</em>}
                  </span>
                </div>
              ))}
              {!rows.length ? <div className="empty-projects"><strong>이 세션에는 요청 행이 없어요.</strong></div> : null}
            </div>

            <p className="filter-note">
              {detail.records.length.toLocaleString('ko-KR')}행 / 전체 {detail.recordCount.toLocaleString('ko-KR')}행
              {detail.truncated ? ` — ${ORDERS.find((item) => item.id === detail.order)?.label ?? ''}으로 앞에서 담았습니다` : ''}
              {' · '}원본을 그 자리에서 다시 읽고 저장하지 않습니다
            </p>
            {detail.collectionTruncated ? (
              <p className="filter-note">
                요청이 수집 상한을 넘어 합계도 전체가 아닙니다 — 위 도구별 배분은 담긴 범위까지의 값입니다.
              </p>
            ) : null}
            {detail.duplicateCount ? (
              <p className="filter-note">
                같은 요청 {detail.duplicateCount.toLocaleString('ko-KR')}건을 한 번만 셌습니다 — 세션을 재개하면 이전 기록이 새 파일로 복사됩니다.
              </p>
            ) : null}
            <p className="filter-note">
              <strong>[보기]</strong> 는 그 호출 하나의 input·결과를 원본에서 읽어 팝업으로 보여 줍니다 —
              목록 응답에는 본문이 들어 있지 않고, 창을 닫으면 버립니다.
            </p>
          </section>
        </>
      ) : null}
      </div>

      {openCall ? (
        <ToolContentModal
          api={api}
          session={{ sessionId: openCall.sessionId, provider: openCall.provider }}
          call={openCall}
          onClose={() => setOpenCall(null)}
        />
      ) : null}
    </>
  );
}
