import { useEffect, useRef, useState } from 'react';
import { initialDirection, nextSort } from '../table-sort.js';

export function ViewHead({ title, subtitle, children }) {
  return (
    <div className="view-head">
      <div><h2>{title}</h2><p>{subtitle}</p></div>
      {children ? <div className="view-head-actions">{children}</div> : null}
    </div>
  );
}

export function MilestonePill({ id }) {
  return <span className="milestone-pill">준비 중 — {id}</span>;
}

// 스냅샷 시각을 그대로 useEffect 의존성에 넣으면, provider 로그가 활발히
// 기록되는 동안 SSE 가 초당 여러 번 스냅샷을 밀어 REST 요청이 응답 전에
// 계속 취소됩니다 — 목록이 영원히 비어 보입니다(실제로 겪었습니다).
//
// 그래서 "느린 시계"를 만들어 씁니다. 값은 최대 intervalMs 마다 한 번만
// 바뀌므로 요청이 완주할 시간이 생깁니다. 필터 변경은 별개 의존성이라
// 즉시 반영됩니다 — 문서가 정한 "필터가 바뀔 때만 당긴다"와 같은 방향입니다.
export function useSlowStamp(stamp, intervalMs = 15_000) {
  const [slow, setSlow] = useState(stamp ?? null);
  const lastAt = useRef(0);
  const pending = useRef(null);

  useEffect(() => {
    if (stamp == null) return undefined;
    pending.current = stamp;
    const elapsed = Date.now() - lastAt.current;
    if (elapsed >= intervalMs) {
      lastAt.current = Date.now();
      setSlow(stamp);
      return undefined;
    }
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setSlow(pending.current);
    }, intervalMs - elapsed);
    return () => clearTimeout(timer);
  }, [stamp, intervalMs]);

  return slow;
}

// ─── 표 헤더 클릭 정렬 ────────────────────────────────────────────────────
// 정렬 규칙 자체는 src/table-sort.js 에 있습니다 — 화면 없이 검증할 수 있어야
// 하는 계약이라서 갈라 두었습니다(원본 값 기준 정렬, 못 잰 값은 항상 끝).
export { sortRows } from '../table-sort.js';

export function useTableSort(columns, defaultKey = null, defaultDirection = null) {
  const initial = (columns ?? []).find((column) => column.key === defaultKey) ?? null;
  const [sort, setSort] = useState({
    key: defaultKey,
    direction: defaultDirection ?? initialDirection(initial),
  });
  const toggle = (key) => setSort((current) => nextSort(columns, current, key));
  return [sort, toggle];
}

export function TableHead({ columns, sort, onSort, className = 'table-row table-head', style }) {
  return (
    <div className={className} role="row" style={style}>
      {columns.map((column) => {
        if (column.sortable === false) return <span key={column.key}>{column.label}</span>;
        const active = sort?.key === column.key;
        // aria-sort 는 role="columnheader" 인 요소에서만 뜻이 있습니다.
        return (
          <span key={column.key} role="columnheader" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button
              type="button"
              className={`sort-header${active ? ` sort-header--${sort.direction}` : ''}`}
              onClick={(event) => { event.stopPropagation(); onSort(column.key); }}
            >
              {column.label}
              <i aria-hidden="true">{active ? (sort.direction === 'asc' ? '▲' : '▼') : '⇅'}</i>
            </button>
          </span>
        );
      })}
    </div>
  );
}
