import { useEffect, useMemo, useState } from 'react';
import { TableHead, ViewHead, sortRows, useSlowStamp, useTableSort } from './Bits.jsx';
import StackedBars from './Chart.jsx';
import {
  buildChartColumns, buildProviderTokenSplits, decomposeTokens, formatTokens, formatPercent,
  qualityBadge, qualityFieldSummary, PENDING_LABEL, resolvePeriodBreakdown,
  sumTokenFields, tokenCategories, tokensText,
  geminiSourceState, geminiTokensBlocked, providerUnavailable,
} from '../shared.js';

const detailColumns = '1.1fr repeat(6, .8fr) .9fr';

const DETAIL_COLUMNS = [
  { key: 'name', label: 'provider', type: 'text' },
  ...tokenCategories.map((category) => ({
    key: category.key,
    label: category.label,
    type: 'number',
    value: (provider) => categoryValue(provider.periodTokens, category.key),
  })),
  { key: 'totalTokens', label: '합계', type: 'number', value: (provider) => provider.periodTokens?.totalTokens },
  { key: 'quality', label: '품질', type: 'text', value: (provider) => provider.quality?.overall },
];

const PERIODS = [
  { id: 'month', label: '이번 달' },
  { id: '7d', label: '최근 7일' },
  { id: '30d', label: '최근 30일' },
  { id: 'all', label: '전체' },
];

const BUCKETS = [
  { id: 'hour', label: '시간' },
  { id: 'day', label: '일' },
  { id: 'week', label: '주' },
  { id: 'month', label: '월' },
];

function sinceFor(period) {
  const now = new Date();
  if (period === 'all') return null;
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

export default function UsageView({ snapshot, api, pending = false }) {
  const providers = snapshot?.providers ?? [];
  const [providerFilter, setProviderFilter] = useState('all');
  const [period, setPeriod] = useState('month');
  const [bucket, setBucket] = useState('day');
  const [timeseries, setTimeseries] = useState(null);
  const [models, setModels] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);

  useEffect(() => {
    if (!api?.usage?.getTimeseries) return undefined;
    let active = true;
    const params = {
      since: sinceFor(period),
      all: period === 'all' ? 1 : null,
      bucket,
      provider: providerFilter === 'all' ? null : providerFilter,
    };
    Promise.all([api.usage.getTimeseries(params), api.usage.getModels(params)])
      .then(([series, breakdown]) => {
        if (!active) return;
        setTimeseries(series);
        setModels(breakdown);
        setLoadError(null);
      })
      .catch((error) => { if (active) setLoadError(error.message || '불러오지 못했습니다'); });
    return () => { active = false; };
  }, [api, period, bucket, providerFilter, stamp]);

  // 시계열은 (버킷 × provider) 로 옵니다. provider 를 버리고 합치면 회계가
  // 섞여 decomposeTokens fallback 이 캐시 읽기를 두 번 셉니다(R4).
  const providerBuckets = useMemo(() => {
    const rows = [];
    for (const point of timeseries?.series ?? []) {
      rows.push({ bucketStart: point.bucketStart, provider: point.provider, tokens: point.tokens });
    }
    return rows.sort((left, right) => (
      left.bucketStart.localeCompare(right.bucketStart) || left.provider.localeCompare(right.provider)
    ));
  }, [timeseries]);

  const visibleBuckets = useMemo(() => (
    providerFilter === 'all'
      ? providerBuckets
      : providerBuckets.filter((row) => row.provider === providerFilter)
  ), [providerBuckets, providerFilter]);

  const periodTotals = useMemo(() => sumTokenFields(visibleBuckets), [visibleBuckets]);

  const chartColumns = useMemo(() => buildChartColumns(visibleBuckets), [visibleBuckets]);

  const periodByProvider = useMemo(() => {
    const map = new Map();
    for (const row of visibleBuckets) {
      const acc = map.get(row.provider) ?? {};
      for (const category of [...tokenCategories, { key: 'totalTokens' }]) {
        acc[category.key] = (acc[category.key] ?? 0) + categoryValue(row.tokens, category.key);
      }
      map.set(row.provider, acc);
    }
    return map;
  }, [visibleBuckets]);

  const rows = (providerFilter === 'all' ? providers : providers.filter((provider) => provider.id === providerFilter))
    .map((provider) => ({ ...provider, periodTokens: periodByProvider.get(provider.id) ?? null }));

  const tokenSplits = useMemo(
    () => buildProviderTokenSplits(rows, periodByProvider),
    [rows, periodByProvider],
  );

  const periodBreakdown = useMemo(
    () => resolvePeriodBreakdown({
      providerFilter,
      splits: tokenSplits,
      mergedDecomposed: decomposeTokens(periodTotals),
      totalTokens: periodTotals.totalTokens,
    }),
    [providerFilter, tokenSplits, periodTotals],
  );

  const qualityMatchesPeriod = period === 'month';
  const [detailSort, toggleDetailSort] = useTableSort(DETAIL_COLUMNS, null);
  const sortedRows = useMemo(() => sortRows(rows, DETAIL_COLUMNS, detailSort), [rows, detailSort]);

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
            disabled={Boolean(providerUnavailable(provider))}
            title={providerUnavailable(provider)?.detail ?? undefined}
            onClick={() => setProviderFilter(provider.id)}
          >{provider.name}</button>
        ))}
      </div>

      <div className="view-stack">
        <section className="panel">
          <div className="panel-head">
            <div><h2>토큰 종류별 추이 <span>••</span></h2><p className="panel-sub">버킷 경계는 로컬 시간대 기준 · provider마다 input 에 캐시 읽기를 넣는 방식이 다릅니다</p></div>
            <span className="quality local">로컬 관측</span>
          </div>
          {loadError ? <div className="empty-projects"><strong>시계열을 불러오지 못했어요.</strong><span>{loadError}</span></div> : <StackedBars columns={chartColumns} bucketLabel={bucketLabel(bucket)} />}
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
            <div className="panel-head">
              <div>
                <h2>기간 합계 <span>••</span></h2>
                <p className="panel-sub">
                  {periodBreakdown.layout === 'providers'
                    ? '차트에 그려진 버킷의 합 · provider별 분해'
                    : '차트에 그려진 버킷의 합'}
                </p>
              </div>
            </div>
            {periodBreakdown.notice ? <p className="filter-note">{periodBreakdown.notice}</p> : null}
            {periodBreakdown.layout === 'providers' ? (
              <div className="token-breakdown usage-period-breakdown">
                {tokenSplits.map((split) => (
                  <div className="token-split" key={split.id}>
                    <span className="token-split-name">{split.name}<small>{split.accounting}{split.nested ? '' : ' · 겹침 미확인'}</small></span>
                    <div className="token-split-cells">
                      {split.segments.map((segment) => (
                        <span key={segment.key}><i className={`legend-dot ${segment.tone}`} />{segment.label} <strong>{segment.value ? formatTokens(segment.value) : '—'}</strong></span>
                      ))}
                      {split.extras.map((extra) => (
                        <span className="token-split-extra" key={extra.key}><i className={`legend-dot ${extra.tone}`} />{extra.label} <strong>{formatTokens(extra.value)}</strong> ({extra.note})</span>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="stat-mini period-total-row"><span>합계</span><strong>{tokensText(periodTotals.totalTokens, pending)}</strong></div>
              </div>
            ) : (
              <div className="stat-mini-grid period-grid">
                {periodBreakdown.categories?.segments.map((segment) => (
                  <div className="stat-mini" key={segment.key}>
                    <span><i className={`legend-dot ${segment.tone}`} />{segment.label}</span>
                    <strong>{segment.value ? formatTokens(segment.value) : '—'}</strong>
                  </div>
                ))}
                <div className="stat-mini"><span>합계</span><strong>{tokensText(periodTotals.totalTokens, pending)}</strong></div>
              </div>
            )}
          </article>
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>provider별 상세 <span>••</span></h2><p className="panel-sub">빈 칸은 0이 아니라 미제공입니다 · 위 차트와 같은 기간{qualityMatchesPeriod ? '' : ' · 품질 등급은 이번 달 창에만 있습니다'}</p></div></div>
          <div className="project-table" role="table">
            <TableHead columns={DETAIL_COLUMNS} sort={detailSort} onSort={toggleDetailSort} style={{ gridTemplateColumns: detailColumns }} />
            {sortedRows.map((provider) => {
              const connected = provider.integration === 'connected';
              const geminiState = provider.id === 'gemini' ? geminiSourceState(provider) : null;
              const tokenBlocked = geminiTokensBlocked(provider);
              const hasData = !tokenBlocked && (provider.periodTokens?.totalTokens ?? 0) > 0;
              const rowPending = pending && Boolean(provider.collector?.detected) && !tokenBlocked;
              return (
                <div className="table-row" role="row" key={provider.id} style={{ gridTemplateColumns: detailColumns }} title={geminiState?.detail ?? undefined}>
                  <strong>{provider.name}</strong>
                  {tokenCategories.map((category) => {
                    const value = categoryValue(provider.periodTokens, category.key);
                    return <span key={category.key}>{tokenBlocked ? '—' : rowPending ? PENDING_LABEL : hasData && value ? formatTokens(value) : '—'}</span>;
                  })}
                  <strong>{tokenBlocked ? '—' : rowPending ? PENDING_LABEL : hasData ? formatTokens(provider.periodTokens?.totalTokens) : '—'}</strong>
                  {tokenBlocked
                    ? <span className="quality">{geminiState.label}</span>
                    : connected && hasData && !qualityMatchesPeriod
                    ? <span className="quality" title="품질 등급은 이번 달 창으로만 계산됩니다">등급 없음</span>
                    : connected && hasData
                    ? (() => {
                        const badge = qualityBadge(provider.quality);
                        const detail = qualityFieldSummary(provider.quality).map((field) => field.text).join(' · ');
                        return <span className={`quality ${badge.tone}`} title={detail}>{badge.label}</span>;
                      })()
                    : connected
                      ? <span className="quality">{(provider.allTimeTotals?.totalTokens ?? 0) > 0 ? '이 기간 기록 없음' : '관측 대기'}</span>
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
