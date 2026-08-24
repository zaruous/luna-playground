import { formatTokens, formatPercent } from '../shared.js';

// 원형(도넛) 차트. 라이브러리 없이 SVG 로 그립니다 — 이 저장소의 다른 차트
// (누적 막대·컨텍스트 곡선)와 같은 방식이고, 조각 수가 손에 꼽습니다.
//
// 조각을 누를 수 있습니다. 누르면 그 범주의 상세 로그가 열립니다. 그래서
// 조각은 <path> 가 아니라 <button> 안의 <path> ... 가 아니라, SVG 안에서는
// button 을 쓸 수 없으므로 role="button" + tabIndex 로 키보드도 받습니다.
const SIZE = 180;
const CENTER = SIZE / 2;
const RADIUS = 74;
const INNER = 44;

function polar(radius, fraction) {
  // 12시 방향에서 시계 방향으로 돕니다.
  const angle = (fraction * 2 * Math.PI) - (Math.PI / 2);
  return { x: CENTER + radius * Math.cos(angle), y: CENTER + radius * Math.sin(angle) };
}

function segmentPath(start, end) {
  const large = end - start > 0.5 ? 1 : 0;
  const outerStart = polar(RADIUS, start);
  const outerEnd = polar(RADIUS, end);
  const innerEnd = polar(INNER, end);
  const innerStart = polar(INNER, start);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${RADIUS} ${RADIUS} 0 ${large} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${INNER} ${INNER} 0 ${large} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

export default function PieChart({
  slices = [],
  activeKey = null,
  onSelect,
  centerLabel = '합계',
  centerValue = null,
  ariaLabel = '범주별 토큰 비중',
}) {
  const total = slices.reduce((sum, slice) => sum + (Number(slice.value) || 0), 0);
  if (!slices.length || total <= 0) {
    return <div className="empty-projects"><strong>나눌 토큰이 없어요.</strong></div>;
  }

  let cursor = 0;
  const drawn = slices.map((slice) => {
    const share = (Number(slice.value) || 0) / total;
    const start = cursor;
    cursor += share;
    return { ...slice, share, start, end: cursor };
  });
  // 조각이 하나뿐이면 호(arc)로는 원을 닫을 수 없습니다 — 시작점과 끝점이
  // 같은 좌표라 아무것도 그려지지 않습니다. 그럴 땐 고리를 통째로 그립니다.
  const single = drawn.length === 1;

  return (
    <div className="pie-wrap">
      <svg className="pie-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={ariaLabel}>
        {single ? (
          <circle
            className={`pie-seg ${drawn[0].tone ?? ''} ${activeKey === drawn[0].key ? 'is-active' : ''}`}
            cx={CENTER}
            cy={CENTER}
            r={(RADIUS + INNER) / 2}
            fill="none"
            strokeWidth={RADIUS - INNER}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            aria-label={`${drawn[0].label} 100%`}
            onClick={() => onSelect?.(drawn[0].key)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(drawn[0].key); } }}
          />
        ) : drawn.map((slice) => (
          <path
            key={slice.key}
            className={`pie-seg ${slice.tone ?? ''} ${activeKey === slice.key ? 'is-active' : ''}`}
            d={segmentPath(slice.start, slice.end)}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            aria-label={`${slice.label} ${formatPercent(slice.share * 100, 1)}`}
            onClick={() => onSelect?.(slice.key)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(slice.key); } }}
          />
        ))}
        <text className="pie-center-value" x={CENTER} y={CENTER - 2} textAnchor="middle">
          {centerValue ?? formatTokens(total)}
        </text>
        <text className="pie-center-label" x={CENTER} y={CENTER + 14} textAnchor="middle">{centerLabel}</text>
      </svg>
      <div className="pie-legend">
        {drawn.map((slice) => (
          <button
            type="button"
            key={slice.key}
            className={`pie-legend-item ${activeKey === slice.key ? 'is-active' : ''}`}
            onClick={() => onSelect?.(slice.key)}
          >
            <i className={slice.tone} />
            <span>{slice.label}</span>
            <strong>{formatTokens(slice.value)}</strong>
            <small>{formatPercent(slice.share * 100, 1)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
