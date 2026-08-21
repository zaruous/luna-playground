import { useEffect, useState } from 'react';
import { ViewHead, MilestonePill, useSlowStamp } from './Bits.jsx';
import QuotaHistory from './QuotaHistory.jsx';
import { providerMilestones, formatTokens, formatPercent, relativeTime, quotaLabel, resetLabel } from '../shared.js';

const reconcileMeta = {
  MATCHED_ACTIVITY: { label: '서버·로컬 동시 증가', tone: 'pill-good' },
  SERVER_ONLY_CHANGE: { label: '서버만 증가 — 로컬 근거 없음', tone: 'pill-warm' },
  LOCAL_ONLY_ACTIVITY: { label: '로컬만 증가 — 서버 미반영', tone: 'pill-muted' },
  RESET: { label: '한도 리셋', tone: 'pill-blue' },
};

// 상황을 아직 못 가져왔을 땐 보여줄 기본값. 생기는 이벤트 목록은
// 설치하기 전에도 "무엇을 건드리는가"를 보여준다는 의미가 있습니다.
const hookDefaults = {
  codex: {
    path: '~/.codex/hooks.json',
    events: ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'],
  },
  claude: {
    path: '~/.claude/settings.json',
    events: ['SessionStart', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStop'],
  },
};

function providerState(provider) {
  const collector = provider.collector ?? {};
  if (provider.integration !== 'connected') {
    return { pill: 'pill-muted', text: `준비 중 — ${providerMilestones[provider.id] ?? '예정'}`, detail: '어댑터 미구현' };
  }
  if (collector.lastError) {
    return { pill: 'pill-red', text: '오류', detail: String(collector.lastError).split('\n')[0] };
  }
  if (collector.detected && collector.watching) {
    return { pill: 'pill-good', text: '연결됨', detail: `${collector.filesDiscovered ?? 0}개 파일 · 감시 중` };
  }
  if (collector.detected) {
    return { pill: 'pill-warm', text: '감지됨', detail: 'reconcile 대기' };
  }
  return { pill: 'pill-warm', text: '미발견', detail: '로그 디렉터리를 찾지 못함' };
}

export default function BudgetView({ snapshot, hookStatuses, api, actionBusy, onToggleHooks, onRescan }) {
  const [history, setHistory] = useState(null);
  const stamp = useSlowStamp(snapshot?.generatedAt ?? null);

  useEffect(() => {
    if (!api?.usage?.getQuotaHistory) return undefined;
    let active = true;
    api.usage.getQuotaHistory({ provider: 'codex' })
      .then((payload) => { if (active) setHistory(payload.points ?? []); })
      .catch(() => { if (active) setHistory([]); });
    return () => { active = false; };
  }, [api, stamp]);
  const providers = snapshot?.providers ?? [];
  const codex = providers.find((provider) => provider.id === 'codex') ?? null;
  const quotaWindows = codex?.quotaWindows ?? [];
  const reconciliation = (codex?.reconciliation?.recent ?? []).filter((row) => row.classification !== 'UNKNOWN');
  const diagnostics = snapshot?.diagnostics ?? null;
  // hook 없이도 수집은 동작해야 하므로 상황을 못 가져와도 카드는 띄워줍니다.
  const hookProviders = providers.filter((provider) => provider.capabilities?.hooks);

  return (
    <>
      <ViewHead title="동기화" subtitle="provider 연결 · 수집 상태 · 대조 이력">
        <button type="button" className="chip-button primary" onClick={onRescan} disabled={!api?.usage || actionBusy}>{actionBusy ? '확인 중…' : '전체 재스캔'}</button>
      </ViewHead>

      <div className="view-stack">
        <section className="card-grid" aria-label="provider 연결 상태">
          {providers.map((provider) => {
            const state = providerState(provider);
            const lastScan = provider.collector?.lastScanAt;
            return (
              <article className="panel provider-card" key={provider.id}>
                <div className="provider-card-head"><h2>{provider.name}</h2><span className={`status-pill ${state.pill}`}>{state.text}</span></div>
                <p className="provider-card-detail">{state.detail}</p>
                <small className="provider-card-sub">{provider.integration === 'connected' ? `마지막 스캔: ${lastScan ? relativeTime(lastScan) : '기록 없음'}` : '설계: docs/dev/provider-token-api.md'}</small>
              </article>
            );
          })}
        </section>

        {hookProviders.map((provider) => {
          const status = hookStatuses?.[provider.id] ?? null;
          const installed = Boolean(status?.installed);
          const settingsPath = status?.settingsPath ?? status?.hooksPath ?? hookDefaults[provider.id]?.path ?? '—';
          return (
            <section className="panel" key={`${provider.id}-hooks`}>
              <div className="panel-head">
                <div>
                  <h2>{provider.name} lifecycle Hook <span>••</span></h2>
                  <p className="panel-sub">가속 경로일 뿐이며 수집 근거는 항상 provider의 durable 로그입니다 — hook을 꺼도 데이터는 사라지지 않아요</p>
                </div>
                <button type="button" className="chip-button primary" onClick={() => onToggleHooks(provider.id)} disabled={!api?.hooks || actionBusy}>{installed ? 'Hook 해제' : 'Hook 설치'}</button>
              </div>
              <div className="hook-events">
                {(status?.expectedEvents ?? hookDefaults[provider.id]?.events ?? []).map((eventName) => (
                  <span key={eventName} className={`hook-event${status?.installedEvents?.includes(eventName) ? ' on' : ''}`}>{eventName}</span>
                ))}
              </div>
              <div className="kv"><span>설정 파일</span><strong>{settingsPath}</strong></div>
              <div className="kv"><span>수정 전 백업</span><strong>{`${settingsPath.split(/[\\/]/).pop()}.nyangtracker.bak`}</strong></div>
              {status?.state === 'conflict' ? <div className="kv"><span>상태</span><strong>설정 파일을 읽지 못했습니다 — 덮어쓰지 않았어요</strong></div> : null}
            </section>
          );
        })}

        <section className="two-col">
          <article className="panel">
            <div className="panel-head"><div><h2>서버 한도 <span>••</span></h2><p className="panel-sub">percent 축 — 토큰으로 변환하지 않습니다</p></div><span className="quality server">서버 관측</span></div>
            {quotaWindows.length ? (
              <div className="gauge-list">
                {quotaWindows.map((window, index) => (
                  <div className="quota-row" key={`${window.limitId}-${window.windowType ?? index}`}>
                    <div className="quota-copy"><span>{quotaLabel(window)}</span><strong>{formatPercent(window.usedPercent)}</strong><small>{resetLabel(window)} · {relativeTime(window.observedAt)}</small></div>
                    <div className="quota-track"><i style={{ width: `${window.usedPercent ?? 0}%` }}/></div>
                  </div>
                ))}
                <QuotaHistory points={history ?? []} />
              </div>
            ) : (
              <div className="empty-projects"><strong>서버 한도 snapshot이 아직 없어요.</strong><span>Codex가 rate_limits를 기록하면 자동으로 나타납니다.</span></div>
            )}
          </article>

          <article className="panel">
            <div className="panel-head"><div><h2>대조 이력 <span>••</span></h2><p className="panel-sub">서버 snapshot 구간과 로컬 토큰 활동의 비교</p></div></div>
            {reconciliation.length ? (
              <div className="recon-list">
                {reconciliation.map((row, index) => {
                  const meta = reconcileMeta[row.classification] ?? { label: row.classification, tone: 'pill-muted' };
                  return (
                    <div className="recon-row" key={`${row.to}-${index}`}>
                      <span className={`status-pill ${meta.tone}`}>{meta.label}</span>
                      <span className="recon-delta">{row.serverUsageDelta != null ? `서버 ${row.serverUsageDelta >= 0 ? '+' : ''}${row.serverUsageDelta.toFixed(1)}%p` : '서버 —'} · 로컬 {formatTokens(row.localTokenDelta)} 토큰</span>
                      <small>{relativeTime(row.to)}</small>
                    </div>
                  );
                })}
                <p className="filter-note">서버만 증가한 구간은 다른 기기·클라우드 실행·지연 정산 가능성이 있어 로컬 값으로 보정하지 않고 보존합니다.</p>
              </div>
            ) : (
              <div className="empty-projects"><strong>대조할 서버 snapshot이 아직 없어요.</strong><span>서버 한도와 로컬 활동이 함께 관측되면 여기서 비교합니다.</span></div>
            )}
          </article>
        </section>

        <section className="panel">
          <div className="panel-head"><div><h2>진단 <span>••</span></h2><p className="panel-sub">SQLite 원장 상태 — 값은 로컬에만 저장됩니다</p></div></div>
          {diagnostics ? (
            <>
              <div className="stat-mini-grid diag-grid">
                <div className="stat-mini"><span>세션</span><strong>{diagnostics.sessions.toLocaleString('ko-KR')}</strong></div>
                <div className="stat-mini"><span>사용 이벤트</span><strong>{diagnostics.usageEvents.toLocaleString('ko-KR')}</strong></div>
                <div className="stat-mini"><span>한도 snapshot</span><strong>{diagnostics.rateSnapshots.toLocaleString('ko-KR')}</strong></div>
                <div className="stat-mini"><span>스캔 파일</span><strong>{diagnostics.scanFiles.toLocaleString('ko-KR')}</strong></div>
                <div className="stat-mini"><span>누적 리셋</span><strong>{diagnostics.cumulativeResets.toLocaleString('ko-KR')}</strong></div>
              </div>
              <div className="kv"><span>SQLite</span><strong>{diagnostics.dbPath}</strong></div>
            </>
          ) : (
            <div className="empty-projects"><strong>서비스에 아직 연결되지 않았어요.</strong><span>usage 서비스가 시작되면 진단 정보가 나타납니다.</span></div>
          )}
        </section>
      </div>
    </>
  );
}
