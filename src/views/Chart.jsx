import { useMemo, useState } from 'react';
import { decomposeTokens, formatTokens } from '../shared.js';

const WIDTH = 760;
const HEIGHT = 240;
const PAD = { top: 16, right: 12, bottom: 26, left: 50 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const SEGMENT_GAP = 2;

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

// 버킷별 토큰 누적 막대. 축은 토큰 하나뿐이고 백분율 한도는 겹쳐 그리지
// 않습니다(R5). 쌓는 조각은 decomposeTokens 가 만든 겹치지 않는 분해입니다(R4).
export default function StackedBars({ buckets, bucketLabel = (value) => value }) {
  const [hovered, setHovered] = useState(null);

  const columns = useMemo(
    () => buckets.map((bucket) => ({ ...bucket, ...decomposeTokens(bucket.tokens) })),
    [buckets],
  );

  if (!columns.length) {
    return <div className="empty-projects"><strong>이 기간에 표시할 사용량이 없어요.</strong><span>기간을 넓히거나 동기화 화면에서 수집 상태를 확인해 보세요.</span></div>;
  }

  const max = niceMax(Math.max(...columns.map((column) => column.sum)));
  const step = PLOT_W / columns.length;
  const barWidth = Math.min(34, Math.max(6, step - 8));
  const labelEvery = Math.ceil(columns.length / 12);
  const approximate = columns.some((column) => !column.nested);
  const legendItems = columns[0].segments.map((segment) => ({
    key: segment.key,
    label: segment.label,
    tone: segment.tone,
    present: columns.some((column) => (column.segments.find((item) => item.key === segment.key)?.value ?? 0) > 0),
  }));

  return (
    <div className="chart-wrap">
      <svg className="chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="버킷별 토큰 누적 막대 차트">
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = PAD.top + PLOT_H * (1 - ratio);
          return (
            <g key={ratio}>
              <line className="chart-grid" x1={PAD.left} y1={y} x2={WIDTH - PAD.right} y2={y} />
              {(ratio === 0 || ratio === 1) && (
                <text className="chart-axis-label" x={PAD.left - 8} y={y + 3} textAnchor="end">{ratio === 0 ? '0' : formatTokens(max)}</text>
              )}
            </g>
          );
        })}

        {columns.map((column, index) => {
          const x = PAD.left + step * index + (step - barWidth) / 2;
          let cursor = PAD.top + PLOT_H;
          return (
            <g
              key={column.bucketStart}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
            >
              <rect className="chart-hit" x={PAD.left + step * index} y={PAD.top} width={step} height={PLOT_H} />
              {column.segments.map((segment) => {
                if (!segment.value) return null;
                const height = (segment.value / max) * PLOT_H;
                if (height < 0.5) return null;
                cursor -= height;
                return <rect key={segment.key} className={`chart-seg ${segment.tone}`} x={x} y={cursor} width={barWidth} height={Math.max(1, height - SEGMENT_GAP)} rx="3" />;
              })}
              {index % labelEvery === 0 && (
                <text className="chart-axis-label" x={PAD.left + step * index + step / 2} y={HEIGHT - 8} textAnchor="middle">{bucketLabel(column.bucketStart)}</text>
              )}
            </g>
          );
        })}
      </svg>

      {hovered != null && columns[hovered] ? (
        <div className="chart-tooltip" style={{ left: `${((PAD.left + step * hovered + step / 2) / WIDTH) * 100}%` }}>
          <strong>{bucketLabel(columns[hovered].bucketStart)}</strong>
          {columns[hovered].segments.filter((segment) => segment.value > 0).map((segment) => (
            <span key={segment.key}><i className={segment.tone} />{segment.label}<b>{formatTokens(segment.value)}</b></span>
          ))}
          <span className="chart-tooltip-total">합계<b>{formatTokens(columns[hovered].sum)}</b></span>
        </div>
      ) : null}

      <div className="legend chart-legend">
        {legendItems.map((item) => (
          <span key={item.key} className={item.present ? '' : 'legend-off'}><i className={item.tone} />{item.label}{item.present ? '' : ' (미제공)'}</span>
        ))}
      </div>
      {approximate ? <p className="filter-note">일부 버킷에서 토큰 범주가 겹치는지 판단할 수 없어 원래 범주를 그대로 쌓았습니다 — 합계가 실제보다 클 수 있습니다.</p> : null}
    </div>
  );
}
