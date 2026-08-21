import { useEffect, useMemo, useState } from 'react';
import { ViewHead, useSlowStamp } from './Bits.jsx';
import StackedBars from './Chart.jsx';
import { decomposeTokens, formatTokens, formatPercent, tokenCategories, qualityBadge, qualityFieldSummary } from '../shared.js';

const detailColumns = '1.1fr repeat(6, .8fr) .9fr';

const PERIODS = [
  { id: 'month', label: '이번 달' },
  { id: '7d', label: '최근 7일' },
  { id: '30d', label: '최근 30일' },
];

const BUCKETS = [
  { id: 'hour', label: '시간' },
  { id: 'day', label: '일' },
  { id: 'week', label: '주' },
  { id: 'month', label: '월' },
];

// 기간 경계는 로컬 시간대로 만듭니다. 스토어의 버킷도 'localtime'으로 끊으므로
// 두 기준이 어긋나면 합계가 맞지 않습니다.
function sinceFor(period) {
  const now = new Date();
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const days = period === '7d' ? 7 : 30;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return start.toISOString();
}

function bucketLabel(bucket) {
  return (value) => {
    if (bucket === 'hour') return value.slice(11) || value;
    if (bucket === 'day') return value.slice(5);
    return value;
  };
}

function categoryValue(tokens, key) {
  return Number(tokens?.[key]) || 0;
}

export default function UsageView({ snapshot, api }) {
  const providers = snapshot?.providers ?? [];
  const [providerFilter, setProviderFilter] = useState('all');
  const [period, setPeriod] = useState('month');
  const [bucket, setBucket] = useState('day');
  const [timeseries, setTimeseries] = useState(null);
  const [models, setModels] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // 같은 이유로 느린 시계를 씁니다(Bits.jsx 의 useSlowStamp 주석 참고).
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);

  useEffect(() => {
    if (!api?.usage?.getTimeseries) return undefined;
    let active = true;
    const params = { since: sinceFor(period), bucket, provider: providerFilter === 'all' ? null : providerFilter };
    Promise.all([api.usage.getTimeseries(params), api.usage.getModels(params)])
      .then(([series, breakdown]) => {
        if (!active) return;
        setTimeseries(series);
        setModels(breakdown);
        setLoadError(null);
      })
      .catch((error) => { if (active) setLoadError(error.message || '불러오지 못했습니다'); });
    return () => { active = false; };
    // 스냅샷이 갱신되면 현재 필터를 유지한 채 다시 당깁니다 (SSE 구독은 App이 유지).
  }, [api, period, bucket, providerFilter, stamp]);

  // 시계열은 (버킷 × provider)로 오므로 화면에서는 버킷 단위로 합칩니다.
  const buckets = useMemo(() => {
    const merged = new Map();
    for (const point of timeseries?.series ?? []) {
      const existing = merged.get(point.bucketStart) ?? { bucketStart: point.bucketStart, tokens: {} };
      for (const category of [...tokenCategories, { key: 'totalTokens' }]) {
        existing.tokens[category.key] = (existing.tokens[category.key] ?? 0) + categoryValue(point.tokens, category.key);
      }
      merged.set(point.bucketStart, existing);
    }
    return [...merged.values()].sort((left, right) => left.bucketStart.localeCompare(right.bucketStart));
  }, [timeseries]);

  const periodTotals = useMemo(() => {
    const totals = { totalTokens: 0 };
    for (const category of tokenCategories) totals[category.key] = 0;
    for (const item of buckets) {
      for (const key of Object.keys(totals)) totals[key] += categoryValue(item.tokens, key);
    }
    return totals;
  }, [buckets]);

  const rows = providerFilter === 'all' ? providers : providers.filter((provider) => provider.id === providerFilter);

  return (
    <>
      <ViewHead title="AI 사용량" subtitle="기간 · provider · 토큰 종류 드릴다운" />

      <div className="filter-bar panel" role="group" aria-label="필터">
        <span className="filter-label">기간</span>
        {PERIODS.map((item) => (
          <button type="button" key={item.id} className={`chip-button ${period === item.id ? 'primary' : ''}`} onClick={() => setPeriod(item.id)}>{item.label}</button>
        ))}
        <span className="filter-label">버킷</span>
        {BUCKETS.map((item) => (
          <button type="button" key={item.id} className={`chip-button ${bucket === item.id ? 'primary' : ''}`} onClick={() => setBucket(item.id)}>{item.label}</button>
        ))}
        <span className="filter-label">provider</span>
        <button type="button" className={`chip-button ${providerFilter === 'all' ? 'primary' : ''}`} onClick={() => setProviderFilter('all')}>전체</button>
        {providers.map((provider) => (
          <button
            type="button"
            key={provider.id}
            className={`chip-button ${providerFilter === provider.id ? 'primary' : ''}`}
            disabled={(provider.totals?.eventCount ?? 0) === 0}
            onClick={() => setProviderFilter(provider.id)}
          >{provider.name}</button>
        ))}
      </div>

      <div className="view-stack">
        <section className="panel">
          <div className="panel-head">
            <div><h2>토큰 종류별 추이 <span>••</span></h2><p className="panel-sub">버킷 경계는 로컬 시간대 기준 · 캐시 읽기는 입력에 합산하지 않습니다</p></div>
            <span className="quality local">로컬 관측</span>
          </div>
          {loadError ? <div className="empty-projects"><strong>시계열을 불러오지 못했어요.</strong><span>{loadError}</span></div> : <StackedBars buckets={buckets} bucketLabel={bucketLabel(bucket)} />}
        </section>

        <section className="two-col">
          <article className="panel">
            <div className="panel-head"><div><h2>모델별 비중 <span>••</span></h2><p className="panel-sub">선택한 기간 내 합계</p></div></div>
            {models?.models?.length ? (
              <div className="gauge-list">
                {models.models.map((item) => (
                  <div className="model-row" key={`${item.provider}-${item.model}`}>
                    <div className="model-copy"><span>{item.model}</span><strong>{formatTokens(item.tokens.totalTokens)}</strong><small>{formatPercent(item.share * 100, 1)}</small></div>
                    <div className="quota-track"><i style={{ width: `${item.share * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-projects"><strong>이 기간에 모델 기록이 없어요.</strong><span>수집된 사용량이 쌓이면 모델별로 나눠 보여줍니다.</span></div>
            )}
          </article>

          <article className="panel">
            <div className="panel-head"><div><h2>기간 합계 <span>••</span></h2><p className="panel-sub">차트에 그려진 버킷의 합</p></div></div>
            <div className="stat-mini-grid period-grid">
              {decomposeTokens(periodTotals).segments.map((segment) => (
                <div className="stat-mini" key={segment.key}>
                  <span><i className={`legend-dot ${segment.tone}`} />{segment.label}</span>
                  <strong>{segment.value ? formatTokens(segment.value) : '—'}</strong>
                </div>
              ))}
              <div className="stat-mini"><span>합계</span><strong>{formatTokens(periodTotals.totalTokens)}</strong></div>
            </div>
          </article>
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>provider별 상세 <span>••</span></h2><p className="panel-sub">빈 칸은 0이 아니라 미제공입니다 · 이번 달 스냅샷 기준</p></div></div>
          <div className="project-table" role="table">
            <div className="table-row table-head" role="row" style={{ gridTemplateColumns: detailColumns }}>
              <span>provider</span><span>입력</span><span>캐시 읽기</span><span>캐시 쓰기</span><span>출력</span><span>추론</span><span>합계</span><span>품질</span>
            </div>
            {rows.map((provider) => {
              const connected = provider.integration === 'connected';
              const hasData = (provider.totals?.eventCount ?? 0) > 0;
              return (
                <div className="table-row" role="row" key={provider.id} style={{ gridTemplateColumns: detailColumns }}>
                  <strong>{provider.name}</strong>
                  {tokenCategories.map((category) => {
                    const value = categoryValue(provider.totals, category.key);
                    return <span key={category.key}>{hasData && value ? formatTokens(value) : '—'}</span>;
                  })}
                  <strong>{hasData ? formatTokens(provider.totals?.totalTokens) : '—'}</strong>
                  {connected && hasData
                    ? (() => {
                        const badge = qualityBadge(provider.quality);
                        const detail = qualityFieldSummary(provider.quality).map((field) => field.text).join(' · ');
                        return <span className={`quality ${badge.tone}`} title={detail}>{badge.label}</span>;
                      })()
                    : connected
                      ? <span className="quality">관측 대기</span>
                      : <span className="quality">미연결</span>}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </>
  );
}
