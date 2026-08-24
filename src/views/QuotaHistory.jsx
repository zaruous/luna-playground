import { windowLabel, formatPercent } from '../shared.js';

const WIDTH = 320;
const HEIGHT = 84;
const PAD = 8;

// 백분율 전용 축입니다. 토큰을 같은 그림에 겹치지 않습니다(R5).
function Sparkline({ points, tone }) {
  if (points.length < 2) return null;
  const first = new Date(points[0].observedAt).getTime();
  const last = new Date(points[points.length - 1].observedAt).getTime();
  const span = Math.max(1, last - first);
  const path = points.map((point, index) => {
    const x = PAD + ((new Date(point.observedAt).getTime() - first) / span) * (WIDTH - PAD * 2);
    const y = PAD + (1 - Math.min(100, point.usedPercent) / 100) * (HEIGHT - PAD * 2);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="한도 사용률 추이 (percent)">
      <line className="chart-grid" x1={PAD} y1={PAD} x2={WIDTH - PAD} y2={PAD} />
      <line className="chart-grid" x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} />
      <path className={`spark-line ${tone}`} d={path} />
    </svg>
  );
}

export default function QuotaHistory({ points }) {
  if (!points.length) return <p className="filter-note">한도 이력이 아직 쌓이지 않았어요. 서버 snapshot이 두 번 이상 관측되면 추이가 나타납니다.</p>;

  const byWindow = new Map();
  for (const point of points) {
    const key = `${point.limitId}|${point.windowMinutes}`;
    if (!byWindow.has(key)) byWindow.set(key, []);
    byWindow.get(key).push(point);
  }

  return (
    <div className="quota-history">
      {[...byWindow.entries()].map(([key, series]) => {
        const latest = series[series.length - 1];
        const tone = latest.usedPercent >= 80 ? 'spark-warm' : 'spark-good';
        return (
          <div className="quota-history-row" key={key}>
            <div className="quota-history-head">
              <span>{windowLabel(latest)} 추이</span>
              <strong>{formatPercent(series[0].usedPercent)} → {formatPercent(latest.usedPercent)}</strong>
            </div>
            <Sparkline points={series} tone={tone} />
            <small>snapshot {series.length}건 · percent 축</small>
          </div>
        );
      })}
    </div>
  );
}
