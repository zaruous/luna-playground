import { useEffect, useMemo, useState } from 'react';
import { TableHead, ViewHead, sortRows, useSlowStamp, useTableSort } from './Bits.jsx';
import StackedBars from './Chart.jsx';
import { decomposeTokens, formatTokens, formatPercent, tokenCategories, qualityBadge, qualityFieldSummary, PENDING_LABEL, tokensText } from '../shared.js';

const detailColumns = '1.1fr repeat(6, .8fr) .9fr';

// 토큰 종류 열은 categoryValue 로 원본 수를 꺼냅니다 — 표에는 '—' 로 그려지는
// 미제공 칸이 섞여 있어서, 그려진 글자로 세우면 '—' 가 숫자들 사이에 끼어듭니다.
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
  // 30일이 상한이면 지난달까지만 쓴 provider 의 기록은 이 화면에서 볼 수 없습니다.
  // 전체 기간이라도 버킷은 활동이 있는 구간만 생겨(실측 948개) 부담이 없습니다.
  { id: 'all', label: '전체' },
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

  // 같은 이유로 느린 시계를 씁니다(Bits.jsx 의 useSlowStamp 주석 참고).
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);

  useEffect(() => {
    if (!api?.usage?.getTimeseries) return undefined;
    let active = true;
    // all 플래그는 SessionView 와 같은 이유로 필요합니다 — null since 는 전송에서
    // 지워지고 서버가 이번 달로 되돌립니다.
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

  // provider별 상세표는 **선택한 기간**을 봐야 합니다. 예전에는 스냅샷의
  // totals(이번 달)를 읽어서, 기간을 전체로 넓히면 위쪽 차트·기간 합계는
  // 9.87억 토큰을 그리는데 바로 아래 같은 provider 행이 전부 '—' 이고 배지가
  // "관측 대기" 로 찍혔습니다 — 한 화면이 같은 provider 를 두고 두 가지를
  // 주장했습니다. 시계열 응답에 provider 가 들어 있어 새 API 없이 접습니다.
  const periodByProvider = useMemo(() => {
    const map = new Map();
    for (const point of timeseries?.series ?? []) {
      const acc = map.get(point.provider) ?? {};
      for (const category of [...tokenCategories, { key: 'totalTokens' }]) {
        acc[category.key] = (acc[category.key] ?? 0) + categoryValue(point.tokens, category.key);
      }
      map.set(point.provider, acc);
    }
    return map;
  }, [timeseries]);

  const rows = (providerFilter === 'all' ? providers : providers.filter((provider) => provider.id === providerFilter))
    .map((provider) => ({ ...provider, periodTokens: periodByProvider.get(provider.id) ?? null }));
  // 기본값은 provider 카탈로그 순서 그대로입니다 — 이 표는 "누가 제일 많이
  // 썼나"보다 "provider 별로 무엇을 재고 있나"를 보는 자리라, 서버가 준 순서를
  // 함부로 흔들지 않습니다. 정렬은 사용자가 헤더를 눌렀을 때만 걸립니다.
  // 스냅샷의 quality 는 "이번 달" 창으로 계산된 값입니다. 그래서 기간이 이번
  // 달일 때만 등급을 붙일 수 있습니다 — 최근 7일·30일도 달 경계를 걸칠 수 있어
  // 창이 일치하지 않습니다.
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
            // 이번 달 창이 아니라 전체 기간으로 판정합니다(SessionView 와 같은 이유).
            disabled={(provider.allTimeTotals?.eventCount ?? 0) === 0}
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
              <div className="stat-mini"><span>합계</span><strong>{tokensText(periodTotals.totalTokens, pending)}</strong></div>
            </div>
          </article>
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>provider별 상세 <span>••</span></h2><p className="panel-sub">빈 칸은 0이 아니라 미제공입니다 · 위 차트와 같은 기간{qualityMatchesPeriod ? '' : ' · 품질 등급은 이번 달 창에만 있습니다'}</p></div></div>
          <div className="project-table" role="table">
            <TableHead columns={DETAIL_COLUMNS} sort={detailSort} onSort={toggleDetailSort} style={{ gridTemplateColumns: detailColumns }} />
            {sortedRows.map((provider) => {
              const connected = provider.integration === 'connected';
              // 이 기간에 값이 있나 — 스냅샷의 이번 달 창이 아니라 선택한 기간입니다.
              const hasData = (provider.periodTokens?.totalTokens ?? 0) > 0;
              // 로그가 발견된 provider 만 "로딩중" 입니다. 어댑터가 없는
              // provider 는 스캔이 끝나도 값이 오지 않으므로 '—'(미제공)입니다.
              const rowPending = pending && Boolean(provider.collector?.detected);
              return (
                <div className="table-row" role="row" key={provider.id} style={{ gridTemplateColumns: detailColumns }}>
                  <strong>{provider.name}</strong>
                  {tokenCategories.map((category) => {
                    const value = categoryValue(provider.periodTokens, category.key);
                    return <span key={category.key}>{rowPending ? PENDING_LABEL : hasData && value ? formatTokens(value) : "—"}</span>;
                  })}
                  <strong>{rowPending ? PENDING_LABEL : hasData ? formatTokens(provider.periodTokens?.totalTokens) : "—"}</strong>
                  {/* 품질 등급은 **이번 달 창으로만** 계산됩니다(스냅샷의 quality).
                      기간이 이번 달이 아니면 그 배지는 남의 기간의 사실이므로
                      붙이지 않습니다. 붙였을 때 실제로 어떻게 되는지 봤습니다:
                      전체 기간에서 Gemini 행이 987.6M 을 찍은 채 옆에 "관측 대기"
                      라고 적혔습니다 — 이번 달 quality 가 비어 있어 qualityBadge
                      가 그 문구로 떨어지기 때문입니다(R7 위반). */}
                  {connected && hasData && !qualityMatchesPeriod
                    ? <span className="quality" title="품질 등급은 이번 달 창으로만 계산됩니다">등급 없음</span>
                    : connected && hasData
                    ? (() => {
                        const badge = qualityBadge(provider.quality);
                        const detail = qualityFieldSummary(provider.quality).map((field) => field.text).join(' · ');
                        return <span className={`quality ${badge.tone}`} title={detail}>{badge.label}</span>;
                      })()
                    : connected
                      // 관측한 적이 없는 것과 이 기간에 활동이 없는 것은 다른
                      // 사실입니다. 원장에 9.8억 토큰이 있는 provider 에게
                      // "관측 대기" 라고 말하면 거짓입니다(R7).
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
