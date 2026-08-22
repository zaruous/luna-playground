import { useState } from 'react';
import { formatTokens } from '../shared.js';

const WIDTH = 760;
const HEIGHT = 240;
const PAD = { top: 16, right: 12, bottom: 26, left: 50 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const SEGMENT_GAP = 2;
const UNDECOMPOSED_PATTERN_ID = 'nyang-chart-undecomposed';

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

// columns 는 buildChartColumns 가 만든 상태입니다 — 여기서 decomposeTokens 를
// 다시 부르지 않습니다(R4). y축과 막대 높이는 totalTokens(원장 합)만 씁니다.
export default function StackedBars({ columns, bucketLabel = (value) => value }) {
  const [hovered, setHovered] = useState(null);

  if (!columns?.length) {
    return <div className="empty-projects"><strong>이 기간에 표시할 사용량이 없어요.</strong><span>기간을 넓히거나 동기화 화면에서 수집 상태를 확인해 보세요.</span></div>;
  }

  const max = niceMax(Math.max(...columns.map((column) => column.totalTokens)));
  const step = PLOT_W / columns.length;
  const barWidth = Math.min(34, Math.max(6, step - 8));
  const labelEvery = Math.ceil(columns.length / 12);
  const approximate = columns.some((column) => column.approximate);
  const extraKeys = new Map();
  for (const column of columns) for (const extra of column.extras ?? []) extraKeys.set(extra.key, extra);

  const legendKeys = new Set();
  for (const column of columns) {
    for (const segment of column.segments) legendKeys.add(segment.key);
    if (column.remainder > 0) legendKeys.add('__remainder');
  }
  const legendItems = [...legendKeys].map((key) => {
    if (key === '__remainder') {
      return { key, label: '분해 불가', undecomposed: true, present: true };
    }
    const sample = columns.find((column) => column.segments.some((segment) => segment.key === key))?.segments
      .find((segment) => segment.key === key);
    return {
      key,
      label: sample?.label ?? key,
      tone: sample?.tone ?? 'tk-input',
      present: columns.some((column) => (column.segments.find((segment) => segment.key === key)?.value ?? 0) > 0),
    };
  });

  return (
    <div className="chart-wrap">
      <svg className="chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="버킷별 토큰 누적 막대 차트">
        <defs>
          {/* SVG rect 는 background 가 아니라 fill 만 씁니다 — HTML 범례와 같은 사선 무늬. */}
          <pattern id={UNDECOMPOSED_PATTERN_ID} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <rect width="8" height="8" fill="var(--soft)" />
            <rect width="3" height="8" fill="var(--muted)" opacity="0.45" />
          </pattern>
        </defs>
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
          const blocks = [
            ...column.segments.filter((segment) => segment.value > 0),
            ...(column.remainder > 0
              ? [{ key: '__remainder', value: column.remainder, label: '분해 불가', undecomposed: true }]
              : []),
          ];
          return (
            <g
              key={column.bucketStart}
              className={column.approximate ? 'chart-col-approximate' : undefined}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
            >
              <rect className="chart-hit" x={PAD.left + step * index} y={PAD.top} width={step} height={PLOT_H} />
              {blocks.map((segment) => {
                const height = (segment.value / max) * PLOT_H;
                if (height < 0.5) return null;
                cursor -= height;
                return (
                  <rect
                    key={segment.key}
                    className={segment.undecomposed ? 'chart-seg chart-seg-undecomposed' : `chart-seg ${segment.tone}`}
                    fill={segment.undecomposed ? `url(#${UNDECOMPOSED_PATTERN_ID})` : undefined}
                    x={x}
                    y={cursor}
                    width={barWidth}
                    height={Math.max(1, height - SEGMENT_GAP)}
                    rx="3"
                  />
                );
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
          {columns[hovered].remainder > 0 ? (
            <span className="chart-tooltip-extra"><i className="legend-dot legend-dot-undecomposed" />분해 불가<b>{formatTokens(columns[hovered].remainder)}</b></span>
          ) : null}
          <span className="chart-tooltip-total">합계<b>{formatTokens(columns[hovered].totalTokens)}</b></span>
          {(columns[hovered].extras ?? []).filter((extra) => extra.value > 0).map((extra) => (
            <span key={extra.key} className="chart-tooltip-extra"><i className={extra.tone} />{extra.label} ({extra.note})<b>{formatTokens(extra.value)}</b></span>
          ))}
          {columns[hovered].approximate ? <span className="chart-tooltip-extra">일부 provider 구간은 범주 분해 불가</span> : null}
        </div>
      ) : null}

      <div className="legend chart-legend">
        {legendItems.map((item) => (
          <span key={item.key} className={item.present ? '' : 'legend-off'}>
            <i className={item.undecomposed ? 'legend-dot legend-dot-undecomposed' : item.tone} />
            {item.label}{item.present ? '' : ' (미제공)'}
          </span>
        ))}
        {[...extraKeys.values()].map((extra) => (
          <span key={extra.key} className="legend-extra"><i className={extra.tone} />{extra.label} ({extra.note})</span>
        ))}
      </div>
      {approximate ? <p className="filter-note">일부 버킷은 로그가 총합만 남겨 범주를 쪼갤 수 없습니다 — 사선 무늬 조각이 분해 불가 구간입니다.</p> : null}
    </div>
  );
}
