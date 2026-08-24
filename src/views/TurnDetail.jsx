import { useEffect, useMemo, useState } from 'react';
import PieChart from './PieChart.jsx';
import { formatBytes, formatTokens, formatPercent, phaseLabel, PENDING_LABEL } from '../shared.js';

// 비싼 턴 한 줄을 펼쳤을 때 나오는 상세.
//
// 표는 "이 턴이 얼마를 썼다"까지 말합니다. 여기서 한 겹 더 내려가 **무엇이
// 가져갔는지**를 봅니다: 채팅 / 도구 / MCP / 파일. 숫자는 원장이 아니라
// 원본 로그를 그 자리에서 다시 읽어 만들고, 저장하지 않습니다. 그래서
// 원본이 지워진 턴에는 상세가 없습니다 — 그럴 땐 그렇다고 적습니다.

const CATEGORY_TONES = {
  chat: 'cat-chat',
  tool: 'cat-tool',
  mcp: 'cat-mcp',
  file: 'cat-file',
};

const CATEGORY_HINTS = {
  chat: '도구를 부르지 않은 요청 — 사람과 주고받은 말과 생각',
  tool: 'CLI 내장 도구 호출 (읽기·편집·실행 등)',
  mcp: 'MCP 서버 도구 호출 — 서버별로 나눕니다',
  file: '도구가 만진 파일 — 도구·MCP 안에서 다시 센 것이라 토큰은 매기지 않습니다',
};

// reason 별 문구. 못 만든 이유가 서로 아주 다르므로 한 문장으로 뭉뚱그리지
// 않습니다 — "파일이 지워졌다" 와 "이 provider 는 원본에 턴이 없다" 는 사람이
// 할 수 있는 일이 다릅니다.
const REASONS = {
  source_missing: {
    title: '원본 로그가 이미 없어요.',
    body: '상세는 원본 파일을 그 자리에서 다시 읽어 만듭니다. 파일이 지워지면 남는 것은 표의 숫자뿐이에요 — 이 턴은 건너뜁니다.',
  },
  no_source: {
    title: '이 턴에 연결된 원본 파일이 없어요.',
    body: '원장에 파일 경로가 남아 있지 않은 턴입니다. 다시 스캔해도 되살아나지 않아요.',
  },
  provider_not_implemented: {
    title: '이 provider 는 턴 상세를 아직 붙이지 않았어요.',
    body: '로그 형태와 턴 경계를 실측으로 확인한 뒤에 켭니다. 확인 전에 반쯤 맞는 상세를 보여 주지 않는 편이 낫습니다.',
  },
  provider_has_no_turns: {
    title: '이 provider 는 원본에 대화 구조가 없어요.',
    body: 'Cursor Admin API 는 이벤트 단위 집계만 줍니다. 결함이 아니라 원본에 정보가 없는 것이라, 만들 수 있는 상세가 없습니다.',
  },
  provider_unknown: {
    title: '모르는 provider 예요.',
    body: '등록표에 없는 provider 입니다.',
  },
};

function TreeNode({ node, depth = 0, activeKey, onSelect }) {
  const [open, setOpen] = useState(depth === 0);
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const active = activeKey && node.key === activeKey;

  return (
    <div className={`turn-tree-node depth-${depth}`}>
      <div className={`turn-tree-row ${active ? 'is-active' : ''}`}>
        <button
          type="button"
          className="turn-tree-toggle"
          onClick={() => setOpen((value) => !value)}
          disabled={!hasChildren}
          aria-expanded={hasChildren ? open : undefined}
          aria-label={hasChildren ? `${node.label} ${open ? '접기' : '펼치기'}` : node.label}
        >{hasChildren ? (open ? '▾' : '▸') : '·'}</button>
        {/* 자리를 늘 차지합니다 — 깊이에 따라 칸이 빠지면 열이 어긋납니다. */}
        <i className={depth === 0 ? `turn-tree-dot ${CATEGORY_TONES[node.key] ?? ''}` : 'turn-tree-dot is-blank'} />
        <span className="turn-tree-label">
          {node.label}
          {node.phase ? <em>{phaseLabel(node.phase)}</em> : null}
        </span>
        <span className="turn-tree-calls">{node.calls ? `${node.calls.toLocaleString('ko-KR')}회` : '—'}</span>
        <strong className="turn-tree-tokens">{node.tokens == null ? '—' : formatTokens(node.tokens)}</strong>
        <span className="turn-tree-share">
          {node.share == null ? '' : formatPercent(node.share * 100, 1)}
        </span>
        {depth === 0 && onSelect ? (
          <button type="button" className="chip-button tiny" onClick={() => onSelect(node.key)}>상세보기</button>
        ) : <span />}
      </div>
      {hasChildren && open ? (
        <div className="turn-tree-children">
          {children.map((child) => (
            <TreeNode key={child.key} node={child} depth={depth + 1} activeKey={activeKey} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
      {depth === 0 && node.note ? <p className="turn-tree-note">{node.note}</p> : null}
    </div>
  );
}

function RecordLog({ detail, category, onCategory }) {
  const [selected, setSelected] = useState(null);
  const records = useMemo(() => (
    category ? detail.records.filter((row) => row.category === category || row.kind === 'turn-start') : detail.records
  ), [detail.records, category]);
  const shown = selected == null ? records : records.filter((row) => row.seq === selected);

  return (
    <div className="turn-log">
      <div className="turn-log-head">
        <div>
          <h3>상세 로그 <span>••</span></h3>
          <p className="panel-sub">
            원본 로그에서 뽑은 <strong>메타데이터만</strong> — 프롬프트·도구 입력·응답 본문은 읽지도, 싣지도 않습니다.
          </p>
        </div>
        <div className="turn-log-filters">
          <button type="button" className={`chip-button tiny ${category ? '' : 'primary'}`} onClick={() => { onCategory(null); setSelected(null); }}>전체</button>
          {detail.categories.filter((row) => row.pie).map((row) => (
            <button
              type="button"
              key={row.key}
              className={`chip-button tiny ${category === row.key ? 'primary' : ''}`}
              onClick={() => { onCategory(row.key); setSelected(null); }}
            >{row.label}</button>
          ))}
        </div>
      </div>

      <div className="turn-log-body">
        <div className="turn-log-list">
          {records.length ? records.map((row) => (
            <button
              type="button"
              key={row.seq}
              className={`turn-log-item ${selected === row.seq ? 'is-active' : ''}`}
              onClick={() => setSelected((current) => (current === row.seq ? null : row.seq))}
            >
              <span className="turn-log-seq">#{row.seq}</span>
              <span className="turn-log-kind">
                {row.kind === 'turn-start' ? '턴 시작' : (detail.categories.find((item) => item.key === row.category)?.label ?? row.category)}
              </span>
              <span className="turn-log-at">
                {row.at ? new Date(row.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
              </span>
              <strong>{row.tokens ? formatTokens(row.tokens.totalTokens) : '—'}</strong>
            </button>
          )) : <div className="empty-projects"><strong>이 범주의 기록이 없어요.</strong></div>}
        </div>
        <pre className="turn-log-json" aria-label="선택한 기록의 JSON 메타데이터">
          {JSON.stringify(selected == null ? records : shown[0] ?? {}, null, 2)}
        </pre>
      </div>

      {detail.truncated ? (
        <p className="filter-note">
          기록 {detail.recordCount.toLocaleString('ko-KR')}건 중 {detail.records.length.toLocaleString('ko-KR')}건만 실었습니다 —
          응답을 부풀리지 않기 위한 상한입니다. 범주별 합계는 잘리지 않은 전체로 계산했습니다.
        </p>
      ) : null}
    </div>
  );
}

export default function TurnDetail({ api, session, turn }) {
  const [state, setState] = useState({ status: 'loading', detail: null, error: null });
  const [category, setCategory] = useState(null);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    if (!api?.sessions?.turnDetail || !session) return undefined;
    let active = true;
    setState({ status: 'loading', detail: null, error: null });
    api.sessions.turnDetail(session.sessionId, turn.turnIndex, { provider: session.provider })
      .then((detail) => { if (active) setState({ status: 'ready', detail, error: null }); })
      .catch((error) => { if (active) setState({ status: 'error', detail: null, error: error.message }); });
    return () => { active = false; };
  }, [api, session?.sessionId, session?.provider, turn?.turnIndex]);

  const openCategory = (key) => {
    setCategory(key === 'file' ? null : key);
    setLogOpen(true);
  };

  if (state.status === 'loading') {
    return <div className="turn-detail"><div className="empty-projects"><strong>{PENDING_LABEL}</strong><span>원본 로그를 다시 읽는 중입니다.</span></div></div>;
  }
  if (state.status === 'error') {
    return (
      <div className="turn-detail">
        <div className="empty-projects"><strong>상세를 불러오지 못했어요.</strong><span>{state.error}</span></div>
      </div>
    );
  }

  const detail = state.detail;
  if (!detail.available) {
    const reason = REASONS[detail.reason] ?? REASONS.provider_unknown;
    return (
      <div className="turn-detail">
        <div className="empty-projects">
          <strong>{reason.title}</strong>
          <span>{reason.body}</span>
        </div>
        {detail.source?.files?.length ? (
          <p className="filter-note">
            찾은 파일 {detail.source.total}개 중 {detail.source.missing}개가 사라졌습니다.
          </p>
        ) : null}
      </div>
    );
  }

  const pieSlices = detail.categories
    .filter((row) => row.pie)
    .map((row) => ({ key: row.key, label: row.label, value: row.tokens, tone: CATEGORY_TONES[row.key] }));
  const drift = detail.measured.totalTokens - detail.ledger.totalTokens;

  return (
    <div className="turn-detail">
      <div className="turn-detail-top">
        <div className="turn-detail-pie">
          <PieChart
            slices={pieSlices}
            activeKey={category}
            onSelect={openCategory}
            centerLabel={`턴 ${detail.turnIndex}`}
            ariaLabel={`턴 ${detail.turnIndex} 의 범주별 토큰 비중`}
          />
          <p className="filter-note">조각을 누르면 그 범주의 상세 로그가 열립니다.</p>
        </div>

        <div className="turn-detail-tree">
          <div className="turn-tree-head">
            <span>범주</span><span>호출</span><span>토큰</span><span>비중</span><span />
          </div>
          {detail.categories.map((node) => (
            <TreeNode
              key={node.key}
              node={{ ...node, note: node.note ?? CATEGORY_HINTS[node.key] }}
              activeKey={category}
              onSelect={openCategory}
            />
          ))}
          {detail.filesMeasured === false ? (
            <p className="turn-tree-note">
              이 provider 는 로그에서 파일 경로를 뽑지 않습니다 — 파일 0개가 아니라 <strong>미측정</strong>입니다.
            </p>
          ) : null}
        </div>
      </div>

      <div className="turn-detail-facts">
        <div className="kv"><span>요청</span><strong>{detail.measured.requestCount.toLocaleString('ko-KR')}개</strong></div>
        <div className="kv"><span>도구 호출</span><strong>{detail.measured.toolCalls.toLocaleString('ko-KR')}회</strong></div>
        <div className="kv"><span>프롬프트 / 출력</span><strong>{formatTokens(detail.measured.promptTokens)} / {formatTokens(detail.measured.outputTokens)}</strong></div>
        {detail.source.files.map((file) => (
          <div className="kv" key={file.label}>
            <span>{file.label === 'main' ? '원본 파일' : `원본 파일 (${file.label})`}</span>
            <strong>
              {file.path ?? '가림 설정으로 숨김'}
              {file.exists ? <small>{file.lines.toLocaleString('ko-KR')}줄 · {formatBytes(file.bytes)}</small> : <small>사라짐 — 건너뜀</small>}
            </strong>
          </div>
        ))}
      </div>

      {/* 원장과 파일이 어긋나면 어느 한쪽을 조용히 고르지 않고 둘 다 적습니다. */}
      {drift !== 0 ? (
        <p className="filter-note turn-detail-drift">
          원장은 {formatTokens(detail.ledger.totalTokens)}, 파일을 다시 읽은 값은 {formatTokens(detail.measured.totalTokens)} 입니다
          ({drift > 0 ? '+' : ''}{formatTokens(drift)}). 마지막 스캔 이후 로그가 더 붙었거나, 원장이 접은 사본이 파일에는 남아 있는 경우입니다.
        </p>
      ) : null}

      <div className="turn-detail-actions">
        <button type="button" className={`chip-button ${logOpen ? 'primary' : ''}`} onClick={() => setLogOpen((value) => !value)}>
          {logOpen ? '상세 로그 접기' : '상세 로그 보기'}
        </button>
        {detail.duplicateCount ? (
          <span className="filter-note">
            같은 요청 {detail.duplicateCount.toLocaleString('ko-KR')}건을 한 번만 셌습니다 — 한 요청이 여러 줄·여러 파일에 걸쳐 기록됩니다.
          </span>
        ) : null}
      </div>

      {logOpen ? <RecordLog detail={detail} category={category} onCategory={setCategory} /> : null}
    </div>
  );
}
