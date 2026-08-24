import { useEffect, useMemo, useRef, useState } from 'react';
import { TableHead, sortRows, useTableSort } from './Bits.jsx';
import TurnDetail from './TurnDetail.jsx';
import { topTools, topTurnsOf } from '../session-turns.js';
import { formatTokens, phaseLabel, PENDING_LABEL } from '../shared.js';

// 비싼 턴 표 + 턴 상세. 세션 흐름 화면과 프로젝트 상세의 세션 표가 **같은
// 컴포넌트**를 씁니다 — 양쪽에 표를 따로 두면 컬럼·정렬·상세 펼침이 조용히
// 갈라지고, 같은 세션이 두 화면에서 다르게 보입니다.
//
// 세션 흐름은 곡선·단계 배분에도 flow 가 필요해서 자기가 이미 들고 있고,
// 프로젝트 상세는 줄을 펼친 세션만 필요합니다. 그래서 flow 를 받는 표
// (ExpensiveTurns)와 flow 를 직접 당기는 껍데기(SessionTurnAnalysis)를
// 갈라 두고, 무거운 호출(원본 파일 재독)은 사람이 줄을 펼쳤을 때만 부릅니다.

export { topTools, topTurnsOf };

// 정렬은 원본 값으로 합니다(table-sort.js 머리말) — 화면 글자는 '4.60B' 처럼
// 나오므로 글자를 세우면 319.6M 이 4.60B 보다 크다고 나옵니다.
export const TURN_COLUMNS = [
  { key: 'turnIndex', label: '턴', type: 'number' },
  { key: 'startedAt', label: '시각', type: 'time' },
  { key: 'totalTokens', label: '토큰', type: 'number' },
  { key: 'requestCount', label: '요청', type: 'number' },
  { key: 'phase', label: '단계', type: 'text' },
  { key: 'toolCounts', label: '도구', sortable: false },
  { key: 'detail', label: '상세', sortable: false },
];
export const turnColumnTemplate = '.5fr .7fr .8fr .5fr .6fr 1.6fr .4fr';

// 세션 흐름 조회. 세션이 바뀌면 이전 세션의 흐름을 그대로 두지 않습니다 —
// 그러면 표는 B 를 가리키는데 곡선은 A 를 그립니다. 반대로 느린 시계(stamp)만
// 바뀐 재조회에서는 이미 그린 값을 지우지 않습니다 — 15초마다 화면이
// 깜빡이는 것은 새 사실이 아닙니다.
export function useSessionFlow(api, session, stamp = null) {
  const sessionId = session?.sessionId ?? null;
  const provider = session?.provider ?? null;
  const key = sessionId ? `${provider ?? ''}|${sessionId}` : null;
  const [state, setState] = useState({ key: null, status: 'idle', flow: null, error: null });

  useEffect(() => {
    if (!api?.sessions?.flow || !key) return undefined;
    let active = true;
    api.sessions.flow(sessionId, { provider })
      .then((payload) => { if (active) setState({ key, status: 'ready', flow: payload, error: null }); })
      .catch((error) => { if (active) setState({ key, status: 'error', flow: null, error: error.message }); });
    return () => { active = false; };
  }, [api, key, sessionId, provider, stamp]);

  if (!key) return { status: 'idle', flow: null, error: null };
  if (state.key !== key) return { status: 'loading', flow: null, error: null };
  return { status: state.status, flow: state.flow, error: state.error };
}

export default function ExpensiveTurns({ api, session, flow, limit = 8 }) {
  const topTurns = useMemo(() => topTurnsOf(flow, limit), [flow, limit]);
  const [turnSort, toggleTurnSort] = useTableSort(TURN_COLUMNS, 'totalTokens');
  const rows = useMemo(() => sortRows(topTurns, TURN_COLUMNS, turnSort), [topTurns, turnSort]);

  // 펼친 턴. 상세는 원본 파일을 다시 읽는 무거운 호출이라 한 번에 하나만
  // 엽니다 — 여러 개를 동시에 펼치면 같은 파일을 그만큼 다시 읽습니다.
  const [openTurn, setOpenTurn] = useState(null);
  // 세션을 바꾸면 펼침을 닫습니다. 턴 번호는 세션마다 다시 1부터라, 그대로
  // 두면 다른 세션의 같은 번호 턴이 열려 있는 것처럼 보입니다.
  const sessionKey = `${session?.provider ?? ''}|${session?.sessionId ?? ''}`;
  const lastSession = useRef(sessionKey);
  if (lastSession.current !== sessionKey) {
    lastSession.current = sessionKey;
    if (openTurn !== null) setOpenTurn(null);
  }

  if (!rows.length) {
    return (
      <div className="empty-projects">
        <strong>턴으로 묶인 요청이 없어요.</strong>
        <span>턴 경계는 사람 프롬프트로 끊습니다 — 경계를 못 찾은 세션에는 펼칠 턴이 없습니다.</span>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <TableHead columns={TURN_COLUMNS} sort={turnSort} onSort={toggleTurnSort} style={{ gridTemplateColumns: turnColumnTemplate }} />
      {rows.map((turn) => (
        <div key={turn.turnIndex}>
          <div
            className={`table-row turn-row ${openTurn === turn.turnIndex ? 'is-open' : ''}`}
            role="row"
            style={{ gridTemplateColumns: turnColumnTemplate }}
            onClick={() => setOpenTurn((current) => (current === turn.turnIndex ? null : turn.turnIndex))}
          >
            <strong>{turn.boundary ? turn.turnIndex : '—'}</strong>
            <span>{turn.startedAt ? new Date(turn.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
            <strong>{formatTokens(turn.totalTokens)}</strong>
            <span>{turn.requestCount}</span>
            <span>{phaseLabel(turn.phase)}{turn.compacted ? ' · 컴팩션' : ''}</span>
            <span className="turn-tools">{turn.boundary ? topTools(turn.toolCounts) : '경계 미확인 (서브에이전트 등)'}</span>
            <span>
              <button
                type="button"
                className="chip-button tiny"
                aria-expanded={openTurn === turn.turnIndex}
                aria-label={`턴 ${turn.turnIndex} 상세 ${openTurn === turn.turnIndex ? '접기' : '펼치기'}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenTurn((current) => (current === turn.turnIndex ? null : turn.turnIndex));
                }}
              >{openTurn === turn.turnIndex ? '▾' : '▸'}</button>
            </span>
          </div>
          {openTurn === turn.turnIndex ? (
            <TurnDetail api={api} session={session} turn={turn} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

// 프로젝트 상세의 세션 표에서 한 줄을 펼쳤을 때 나오는 블록. 세션 흐름 화면의
// "비싼 턴" 절과 같은 표·같은 상세를 씁니다. 곡선과 단계 배분은 세션 흐름
// 화면에 남깁니다 — 여기서는 "이 세션의 어느 턴이 비쌌고 그 턴이 무엇에
// 썼나" 까지가 질문이고, 그 위로 올라가려면 세션 흐름 화면으로 가야 합니다.
export function SessionTurnAnalysis({ api, session, stamp = null, limit = 8, onOpenFlow = null }) {
  const { status, flow, error } = useSessionFlow(api, session, stamp);
  // 상한이 아니라 실제로 담긴 개수를 적습니다 — 턴이 3개인 세션에 "상위 8개"
  // 라고 쓰면 5개를 어딘가에서 잘라냈다는 뜻으로 읽힙니다.
  const shown = useMemo(() => topTurnsOf(flow, limit).length, [flow, limit]);

  return (
    <div className="session-analysis">
      <div className="session-analysis-head">
        <div>
          <h3>비싼 턴 <span>••</span></h3>
          <p className="panel-sub">
            토큰 상위 {shown}개 · 턴 = 사람 프롬프트 1개 ~ 다음 프롬프트까지 · <strong>행을 누르면</strong> 그 턴이 무엇에 썼는지 펼쳐집니다
          </p>
        </div>
        <div className="session-analysis-actions">
          {flow ? (
            <span className="filter-note">
              턴 {flow.session.turnCount}개 · 요청 {flow.session.requestCount.toLocaleString('ko-KR')}개
            </span>
          ) : null}
          {onOpenFlow ? (
            <button type="button" className="chip-button tiny" onClick={onOpenFlow}>세션 흐름 →</button>
          ) : null}
        </div>
      </div>

      {status === 'loading' ? (
        <div className="empty-projects"><strong>{PENDING_LABEL}</strong><span>이 세션의 턴 구조를 읽는 중입니다.</span></div>
      ) : null}
      {/* 404 는 "원장에 이 세션의 요청이 없다" 입니다 — 오류처럼 적지 않고
          그렇다고 적습니다(기간을 좁혀 보던 표에서 자주 나옵니다). */}
      {status === 'error' ? (
        <div className="empty-projects">
          <strong>이 세션의 흐름을 불러오지 못했어요.</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {status === 'ready' && flow ? (
        <>
          <ExpensiveTurns api={api} session={session} flow={flow} limit={limit} />
          <div className="kv">
            <span>메인 transcript</span>
            <strong>{flow.source.mainSourcePath ?? '가림 설정으로 숨김'}</strong>
          </div>
          <p className="filter-note">
            상세는 원본 파일을 그 자리에서 다시 읽어 만듭니다 — 대화 본문은 읽지도, 저장하지도 않습니다.
          </p>
        </>
      ) : null}
    </div>
  );
}
