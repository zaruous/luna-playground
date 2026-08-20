import { useMemo, useState } from 'react';
import { ViewHead, MilestonePill } from './Bits.jsx';
import { providerCatalog, formatTokens, formatPercent, tokenCategories } from '../shared.js';

const detailColumns = '1.1fr repeat(6, .8fr) .9fr';

function categoryValue(totals, key) {
  return Number(totals?.[key]) || 0;
}

export default function UsageView({ snapshot }) {
  const providers = snapshot?.providers ?? [];
  const totals = snapshot?.totals ?? null;
  const [providerFilter, setProviderFilter] = useState('all');

  const measured = useMemo(
    () => providers.filter((provider) => (provider.totals?.eventCount ?? 0) > 0),
    [providers],
  );
  const visible = providerFilter === 'all' ? measured : measured.filter((provider) => provider.id === providerFilter);

  return (
    <>
      <ViewHead title="AI 사용량" subtitle="provider · 토큰 종류 드릴다운 — 이번 달 로컬 관측 기준" />

      <div className="filter-bar panel" role="group" aria-label="필터">
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
        <span className="filter-note">기간: 이번 달 (스냅샷 기준) · 기간·버킷 필터는 M2</span>
      </div>

      <div className="view-stack">
        <section className="panel">
          <div className="panel-head"><div><h2>토큰 종류별 구성 <span>••</span></h2><p className="panel-sub">입력 · 캐시 읽기 · 캐시 쓰기 · 출력 · 추론 — provider마다 제공 범주가 다릅니다</p></div><span className="quality local">이번 달 로컬 관측</span></div>
          {visible.length ? (
            <div className="stack-list">
              {visible.map((provider) => {
                const providerTotal = Math.max(1, provider.totals?.totalTokens ?? 0);
                return (
                  <div className="stack-row" key={provider.id}>
                    <div className="stack-name"><strong>{provider.name}</strong><small>{formatTokens(provider.totals?.totalTokens)} 토큰 · {provider.totals?.eventCount ?? 0} 이벤트</small></div>
                    <div className="stack-bar" role="img" aria-label={`${provider.name} 토큰 종류별 구성`}>
                      {tokenCategories.map((category) => {
                        const value = categoryValue(provider.totals, category.key);
                        if (!value) return null;
                        return <i key={category.key} className={category.tone} style={{ width: `${(value / providerTotal) * 100}%` }} title={`${category.label} ${formatTokens(value)}`} />;
                      })}
                    </div>
                  </div>
                );
              })}
              <div className="legend">
                {tokenCategories.map((category) => {
                  const present = visible.some((provider) => categoryValue(provider.totals, category.key) > 0);
                  return <span key={category.key} className={present ? '' : 'legend-off'}><i className={category.tone} />{category.label}{present ? '' : ' (미제공)'}</span>;
                })}
              </div>
            </div>
          ) : (
            <div className="empty-projects"><strong>이번 달 관측된 사용량이 아직 없어요.</strong><span>동기화 화면에서 수집 상태를 확인해 보세요.</span></div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>provider별 상세 <span>••</span></h2><p className="panel-sub">빈 칸은 0이 아니라 미제공입니다</p></div></div>
          <div className="project-table" role="table">
            <div className="table-row table-head" role="row" style={{ gridTemplateColumns: detailColumns }}>
              <span>provider</span><span>입력</span><span>캐시 읽기</span><span>캐시 쓰기</span><span>출력</span><span>추론</span><span>합계</span><span>품질</span>
            </div>
            {providers.map((provider) => {
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
                    ? <span className="quality local">로컬 관측</span>
                    : connected
                      ? <span className="quality">관측 대기</span>
                      : <span className="quality">미연결</span>}
                </div>
              );
            })}
            {totals ? (
              <div className="table-row table-total" role="row" style={{ gridTemplateColumns: detailColumns }}>
                <strong>합계</strong>
                {tokenCategories.map((category) => <span key={category.key}>{formatTokens(categoryValue(totals, category.key))}</span>)}
                <strong>{formatTokens(totals.totalTokens)}</strong>
                <span className="quality local">로컬 관측</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel planned-panel">
          <div className="panel-head"><div><h2>추이 차트 · 모델별 비중</h2><p className="panel-sub">버킷별(시간/일/주/월) 누적 막대와 모델 비중은 시계열 API와 함께 제공됩니다</p></div><MilestonePill id="M2" /></div>
          <p className="planned-copy">시계열은 SSE 스냅샷에 싣지 않고 필터가 바뀔 때만 REST(<code>GET /api/v1/usage/timeseries</code>)로 당기는 설계입니다. 화면 설계: docs/dev/menus/usage.md</p>
        </section>
      </div>
    </>
  );
}
