import { useEffect, useMemo, useState } from 'react';
import { TableHead, ViewHead, sortRows, useSlowStamp, useTableSort } from './Bits.jsx';
import { formatTokens, formatPercent, relativeTime, phaseLabel, PENDING_LABEL, tokensText } from '../shared.js';

const PERIODS = [
  { id: 'month', label: '이번 달' },
  { id: '7d', label: '최근 7일' },
  { id: '30d', label: '최근 30일' },
  { id: 'all', label: '전체' },
];

const rankColumns = '1.3fr .8fr .5fr .5fr .6fr .7fr .6fr';

// 정렬은 원본 값으로 합니다. 토큰은 '4.60B' 같은 글자로 그려지고, 재독 배수는
// null 이 섞이며(관측 없음), 턴 수는 0 이 아니라 '—' 로 나옵니다 — 화면 글자를
// 세우면 이 셋이 전부 엉킵니다(Bits.jsx sortRows 주석 참고).
const RANK_COLUMNS = [
  { key: 'projectName', label: '프로젝트', type: 'text' },
  { key: 'totalTokens', label: '총 토큰', type: 'number', value: (row) => row.tokens?.totalTokens },
  { key: 'requestCount', label: '요청', type: 'number' },
  { key: 'turnCount', label: '턴', type: 'number' },
  { key: 'reuseMultiple', label: '재독', type: 'number' },
  { key: 'dominantPhase', label: '우세 단계', type: 'text' },
  { key: 'navigate', label: '이동', sortable: false },
];

const TURN_COLUMNS = [
  { key: 'turnIndex', label: '턴', type: 'number' },
  { key: 'startedAt', label: '시각', type: 'time' },
  { key: 'totalTokens', label: '토큰', type: 'number' },
  { key: 'requestCount', label: '요청', type: 'number' },
  { key: 'phase', label: '단계', type: 'text' },
  { key: 'toolCounts', label: '도구', sortable: false },
];
const turnColumnTemplate = '.5fr .7fr .8fr .5fr .6fr 1.6fr';

// 기간 경계는 로컬 시간대로 만듭니다 — 스토어도 'localtime'으로 끊습니다.
function sinceFor(period) {
  if (period === 'all') return null;
  const now = new Date();
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const days = period === '7d' ? 7 : 30;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).toISOString();
}

function reuseLabel(value) {
  if (value == null) return '—';
  if (value < 10) return `${value.toFixed(1)}x`;
  return `${Math.round(value)}x`;
}

function topTools(toolCounts, limit = 4) {
  return Object.entries(toolCounts ?? {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');
}

// 컨텍스트 곡선. 라이브러리 없이 SVG로 그립니다 — 대시보드의 막대·게이지와
// 같은 방식이고, 이 화면도 점 개수가 유한합니다(서버가 버킷으로 줄여 보냅니다).
function ContextCurve({ curve }) {
  if (!curve?.length) return <div className="empty-projects"><strong>곡선을 그릴 요청이 없어요.</strong></div>;
  const width = 640;
  const height = 170;
  const padding = { top: 12, right: 8, bottom: 20, left: 8 };
  const peak = Math.max(...curve.map((point) => point.peakPromptTokens), 1);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const x = (index) => padding.left + (curve.length === 1 ? innerWidth / 2 : (index / (curve.length - 1)) * innerWidth);
  const y = (value) => padding.top + innerHeight - (value / peak) * innerHeight;
  const area = `M ${x(0)} ${y(0)} ${curve.map((point, index) => `L ${x(index)} ${y(point.promptTokens)}`).join(' ')} L ${x(curve.length - 1)} ${y(0)} Z`;
  const line = curve.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index)} ${y(point.promptTokens)}`).join(' ');

  return (
    <div className="curve-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="context-curve" role="img" aria-label="요청별 프롬프트 크기 추이">
        <path d={area} className="curve-area" />
        <path d={line} className="curve-line" />
        {curve.map((point, index) => (point.compacted
          ? <line key={`compact-${point.requestIndex}`} x1={x(index)} x2={x(index)} y1={padding.top} y2={padding.top + innerHeight} className="curve-compact" />
          : null))}
        <line x1={padding.left} x2={width - padding.right} y1={padding.top + innerHeight} y2={padding.top + innerHeight} className="curve-axis" />
      </svg>
      <div className="curve-legend">
        <span>최고 <strong>{formatTokens(peak)}</strong></span>
        <span>요청 <strong>{curve[curve.length - 1].requestIndex.toLocaleString('ko-KR')}</strong>개</span>
        {curve.some((point) => point.compacted) ? <span className="curve-compact-legend">세로선 = 컴팩션</span> : null}
      </div>
    </div>
  );
}

export default function SessionView({ snapshot, api, focus, pending = false, onNavigate }) {
  const providers = snapshot?.providers ?? [];
  const [period, setPeriod] = useState('month');
  const [providerFilter, setProviderFilter] = useState('all');
  const [sessions, setSessions] = useState(null);
  const [selected, setSelected] = useState(null);
  const [flow, setFlow] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // 스냅샷 시각을 그대로 쓰면 SSE 가 밀어대는 동안 요청이 계속 취소됩니다.
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);
  // 프로젝트 탭에서 넘어온 포커스. 그 프로젝트의 세션만 보여줍니다.
  const focusProjectKey = focus?.projectKey ?? null;

  useEffect(() => {
    if (!api?.sessions?.list) return undefined;
    let active = true;
    api.sessions.list({
      since: sinceFor(period),
      // sinceFor('all') 은 null 이고 null 파라미터는 전송에서 지워집니다. 그러면
      // 서버는 "생략" 과 구분할 수 없어 이번 달로 되돌립니다 — 그래서 전체 기간은
      // 플래그로 따로 말해야 합니다(service/api-server.mjs 의 #since).
      all: period === 'all' ? 1 : null,
      provider: providerFilter === 'all' ? null : providerFilter,
      limit: 40,
    })
      .then((payload) => { if (active) { setSessions(payload.sessions ?? []); setLoadError(null); } })
      .catch((error) => { if (active) { setSessions([]); setLoadError(error.message); } });
    return () => { active = false; };
  }, [api, period, providerFilter, stamp]);

  const list = useMemo(() => {
    const rows = sessions ?? [];
    if (!focusProjectKey) return rows;
    return rows.filter((row) => row.projectKey === focusProjectKey);
  }, [sessions, focusProjectKey]);

  const [rankSort, toggleRankSort] = useTableSort(RANK_COLUMNS, 'totalTokens');
  // 화면에 보이는 순서와 "첫 행" 이 같아야 합니다 — 정렬을 바꿨는데 기본 선택이
  // 예전 1등에 남아 있으면 아래 흐름이 표와 어긋납니다.
  const sortedList = useMemo(() => sortRows(list, RANK_COLUMNS, rankSort), [list, rankSort]);
  const rankSortLabel = RANK_COLUMNS.find((column) => column.key === rankSort.key)?.label ?? '기본';
  const activeSession = sortedList.find((row) => row.sessionId === selected) ?? sortedList[0] ?? null;

  useEffect(() => {
    if (!api?.sessions?.flow || !activeSession) { setFlow(null); return undefined; }
    let active = true;
    api.sessions.flow(activeSession.sessionId, { provider: activeSession.provider })
      .then((payload) => { if (active) setFlow(payload); })
      .catch(() => { if (active) setFlow(null); });
    return () => { active = false; };
  }, [api, activeSession?.sessionId, activeSession?.provider, stamp]);

  const summary = useMemo(() => {
    if (!list.length) return null;
    const worst = list.reduce((acc, row) => ((row.reuseMultiple ?? 0) > (acc?.reuseMultiple ?? 0) ? row : acc), null);
    const phases = new Map();
    for (const row of list) {
      if (!row.dominantPhase) continue;
      phases.set(row.dominantPhase, (phases.get(row.dominantPhase) ?? 0) + row.tokens.totalTokens);
    }
    const dominant = [...phases.entries()].sort((left, right) => right[1] - left[1])[0] ?? null;
    return { count: list.length, worst, dominant };
  }, [list]);

  // 무엇을 담을지(토큰 상위 8개)를 먼저 정하고, 그 8개를 어떤 순서로 세울지는
  // 헤더가 정합니다. 기본값이 토큰 내림차순이라 정렬을 건드리지 않으면 이전과
  // 같은 표입니다.
  const topTurns = useMemo(() => (
    [...(flow?.turns ?? [])].sort((left, right) => right.totalTokens - left.totalTokens).slice(0, 8)
  ), [flow]);
  const [turnSort, toggleTurnSort] = useTableSort(TURN_COLUMNS, 'totalTokens');
  const expensiveTurns = useMemo(() => sortRows(topTurns, TURN_COLUMNS, turnSort), [topTurns, turnSort]);

  return (
    <>
      <ViewHead
        title="세션 흐름"
        subtitle="어떤 절차로 얼마를 썼는지 — 대화 본문은 읽지도, 저장하지도 않습니다"
      >
        {focusProjectKey ? (
          <button type="button" className="chip-button" onClick={() => onNavigate?.('session', null)}>프로젝트 필터 해제</button>
        ) : null}
      </ViewHead>

      <div className="panel filter-bar">
        <span className="filter-label">기간</span>
        {PERIODS.map((item) => (
          <button type="button" key={item.id} className={`chip-button ${period === item.id ? 'primary' : ''}`} onClick={() => setPeriod(item.id)}>{item.label}</button>
        ))}
        <span className="filter-label">provider</span>
        <button type="button" className={`chip-button ${providerFilter === 'all' ? 'primary' : ''}`} onClick={() => setProviderFilter('all')}>전체</button>
        {providers.map((provider) => (
          <button
            type="button"
            key={provider.id}
            className={`chip-button ${providerFilter === provider.id ? 'primary' : ''}`}
            // 비활성 기준은 "이 provider 가 **한 번이라도** 관측됐나" 입니다.
            // 스냅샷의 totals 는 이번 달 창이라, 그것으로 잠그면 지난달까지만
            // 쓰던 provider 는 기간을 넓혀도 영영 고를 수 없습니다 — Gemini 에서
            // 실제로 그랬습니다(전체 기간에 9.8억 토큰인데 칩이 잠겨 있었음).
            disabled={(provider.allTimeTotals?.eventCount ?? 0) === 0}
            onClick={() => setProviderFilter(provider.id)}
          >{provider.name}</button>
        ))}
        <p className="filter-note">재독 배수 = 캐시 읽기 / (비캐시 입력 + 출력)</p>
      </div>

      <div className="view-stack">
        <section className="stat-mini-grid">
          <article className="stat-card mini">
            <div className="stat-label">관측 세션 <span>••</span></div>
            <strong>{pending ? PENDING_LABEL : summary?.count ?? 0}</strong>
            <p>{focusProjectKey ? '프로젝트 필터 적용' : '기간 내 토큰 순'}</p>
          </article>
          <article className="stat-card mini">
            <div className="stat-label">최고 재독 배수 <span>••</span></div>
            <strong className="orange-text">{reuseLabel(summary?.worst?.reuseMultiple)}</strong>
            <p>{summary?.worst?.projectName ?? '—'}</p>
          </article>
          <article className="stat-card mini">
            <div className="stat-label">가장 비싼 턴 <span>••</span></div>
            {/* 표의 첫 행이 아니라 토큰 최댓값을 직접 읽습니다 — 아래 표는
                헤더로 정렬을 바꿀 수 있어서, 첫 행을 "가장 비싼" 이라고 부르면
                시각순으로 세운 순간 거짓이 됩니다. */}
            <strong className="violet-text">{topTurns[0] ? formatTokens(topTurns[0].totalTokens) : '—'}</strong>
            <p>{topTurns[0] ? `턴 ${topTurns[0].turnIndex} · 요청 ${topTurns[0].requestCount}개` : '세션을 선택하세요'}</p>
          </article>
          <article className="stat-card mini">
            <div className="stat-label">우세 단계 <span>••</span></div>
            <strong className="mint-text">{summary?.dominant ? phaseLabel(summary.dominant[0]) : '—'}</strong>
            <p>도구 이름으로 분류 · 추정 배분</p>
          </article>
        </section>

        <section className="panel">
          <div className="panel-head">
            {/* 서버는 총 토큰 상위 40개를 줍니다. 헤더 정렬은 그 40개를 다시
                세우는 것이지 전체에서 다시 뽑는 것이 아닙니다 — 부제가 "총 토큰
                순"으로 고정되어 있으면 재독순으로 세운 표와 어긋나고, 반대로
                "재독순"으로만 적으면 전체에서 재독 상위를 뽑은 것처럼 읽힙니다. */}
            <div><h2>세션 순위 <span>••</span></h2><p className="panel-sub">총 토큰 상위 {list.length}개를 {rankSortLabel} {rankSort.direction === 'asc' ? '오름차순' : '내림차순'}으로 정렬 · 행을 누르면 아래 흐름이 바뀝니다</p></div>
          </div>
          {loadError ? <div className="empty-projects"><strong>세션 목록을 불러오지 못했어요.</strong><span>{loadError}</span></div> : null}
          <div className="table-wrap">
            <TableHead columns={RANK_COLUMNS} sort={rankSort} onSort={toggleRankSort} style={{ gridTemplateColumns: rankColumns }} />
            {sortedList.length ? sortedList.map((row) => (
              <div
                className={`table-row session-row ${activeSession?.sessionId === row.sessionId ? 'is-active' : ''}`}
                role="row"
                key={`${row.provider}-${row.sessionId}`}
                style={{ gridTemplateColumns: rankColumns }}
                onClick={() => setSelected(row.sessionId)}
              >
                <strong>
                  {row.projectName}
                  <small>{row.provider} · {row.model ?? '모델 미확인'} · {relativeTime(row.lastAt)}</small>
                </strong>
                <strong>{formatTokens(row.tokens.totalTokens)}</strong>
                <span>{row.requestCount.toLocaleString('ko-KR')}</span>
                <span>{row.turnCount ? row.turnCount.toLocaleString('ko-KR') : '—'}</span>
                <span>{reuseLabel(row.reuseMultiple)}</span>
                <span>{phaseLabel(row.dominantPhase)}</span>
                <span>
                  <button
                    type="button"
                    className="chip-button tiny"
                    onClick={(event) => { event.stopPropagation(); onNavigate?.('project', { projectKey: row.projectKey }); }}
                  >프로젝트 →</button>
                </span>
              </div>
            )) : (
              <div className="empty-projects">
                <strong>{pending ? PENDING_LABEL : "이 기간에 관측된 세션이 없어요."}</strong>
                <span>기간을 넓히거나 provider 필터를 확인해 보세요.</span>
              </div>
            )}
          </div>
        </section>

        {flow ? (
          <>
            <section className="two-col">
              <article className="panel">
                <div className="panel-head">
                  <div>
                    <h2>컨텍스트 곡선 <span>••</span></h2>
                    <p className="panel-sub">요청별 프롬프트 크기 = 비캐시 입력 + 캐시 읽기 + 캐시 쓰기</p>
                  </div>
                  <span className="quality local">원장 계산</span>
                </div>
                <ContextCurve curve={flow.curve} />
                <div className="kv"><span>최고 프롬프트</span><strong>{formatTokens(flow.session.peakPromptTokens)}</strong></div>
                <div className="kv"><span>요청당 평균</span><strong>{formatTokens(flow.session.requestCount ? flow.session.promptTokens / flow.session.requestCount : 0)}</strong></div>
                <div className="kv"><span>컴팩션</span><strong>{flow.session.compactionCount}회</strong></div>
              </article>

              <article className="panel">
                <div className="panel-head">
                  <div>
                    <h2>단계별 배분 <span>••</span></h2>
                    <p className="panel-sub">도구 이름으로만 분류 · 한 턴에 섞이면 호출 비율로 나눔</p>
                  </div>
                  <span className="quality partial">추정 배분</span>
                </div>
                <div className="phase-list">
                  {flow.phases.length ? flow.phases.map((row) => (
                    <div className="phase-row" key={row.phase}>
                      <span>{phaseLabel(row.phase)}</span>
                      <div className="phase-track"><i style={{ width: `${Math.max(1, row.share * 100)}%` }} /></div>
                      <strong>{formatTokens(row.tokens)}</strong>
                      <small>{formatPercent(row.share * 100, 1)}</small>
                    </div>
                  )) : <div className="empty-projects"><strong>도구 호출 기록이 없어요.</strong></div>}
                </div>
              </article>
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>비싼 턴 <span>••</span></h2>
                  <p className="panel-sub">토큰 상위 {topTurns.length}개 · 턴 = 사람 프롬프트 1개 ~ 다음 프롬프트까지 · 프롬프트 본문은 저장하지 않습니다</p>
                </div>
                <span className="filter-note">
                  턴 {flow.session.turnCount}개 · 요청 {flow.session.requestCount.toLocaleString('ko-KR')}개
                </span>
              </div>
              <div className="table-wrap">
                <TableHead columns={TURN_COLUMNS} sort={turnSort} onSort={toggleTurnSort} style={{ gridTemplateColumns: turnColumnTemplate }} />
                {expensiveTurns.map((turn) => (
                  <div className="table-row" role="row" key={turn.turnIndex} style={{ gridTemplateColumns: turnColumnTemplate }}>
                    <strong>{turn.boundary ? turn.turnIndex : '—'}</strong>
                    <span>{turn.startedAt ? new Date(turn.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                    <strong>{formatTokens(turn.totalTokens)}</strong>
                    <span>{turn.requestCount}</span>
                    <span>{phaseLabel(turn.phase)}{turn.compacted ? ' · 컴팩션' : ''}</span>
                    <span className="turn-tools">{turn.boundary ? topTools(turn.toolCounts) : '경계 미확인 (서브에이전트 등)'}</span>
                  </div>
                ))}
              </div>
              <div className="kv">
                <span>메인 transcript</span>
                <strong>{flow.source.mainSourcePath ?? '가림 설정으로 숨김'}</strong>
              </div>
              <div className="kv">
                <span>transcript 파일</span>
                <strong>{flow.source.transcriptCount}개 (메인 + 서브에이전트)</strong>
              </div>
              <p className="filter-note">
                이 화면은 원본 파일의 위치만 보여줍니다. 대화 내용은 DB에 저장되지 않으므로,
                원본이 지워지면 여기 남는 것은 토큰과 절차뿐입니다.
              </p>
            </section>
          </>
        ) : null}
      </div>
    </>
  );
}
