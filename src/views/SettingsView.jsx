import { useCallback, useEffect, useState } from 'react';
import CatArt from '../CatArt.jsx';
import { ViewHead, MilestonePill } from './Bits.jsx';
import { catThemes, formatBytes, RESET_CONFIRMATION } from '../shared.js';
import pkg from '../../package.json';

export default function SettingsView({ snapshot, api, catTheme, onSelectTheme }) {
  const diagnostics = snapshot?.diagnostics ?? null;
  const providers = snapshot?.providers ?? [];
  const connected = providers.filter((provider) => provider.integration === 'connected');
  const serviceUrl = window.__NYANG_TRACKER_CONFIG__?.transport?.baseUrl ?? null;

  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [failure, setFailure] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [keepAliases, setKeepAliases] = useState(true);

  const load = useCallback(() => {
    if (!api?.data) return;
    api.data.status().then(setData).catch((error) => setFailure(error.message));
  }, [api]);

  useEffect(load, [load]);

  const run = async (label, action) => {
    setBusy(label); setNotice(null); setFailure(null);
    try {
      const result = await action();
      setData(result);
      return result;
    } catch (error) {
      setFailure(error.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const onBackup = () => run('backup', async () => {
    const result = await api.data.backup();
    setNotice(`백업을 만들었어요 — ${result.backup.name} (${formatBytes(result.backup.sizeBytes)})`);
    return result;
  });

  const onReset = () => run('reset', async () => {
    const result = await api.data.reset({ confirm: RESET_CONFIRMATION, keepAliases, backupFirst: true });
    setConfirmText('');
    const kept = result.keptAliases ? '별칭·가림은 남겼어요' : '별칭·가림도 지웠어요';
    setNotice(`원장을 비우고 다시 재는 중이에요. ${kept}. 백업: ${result.backup?.name ?? '만들지 않음'}`);
    return result;
  });

  const counters = data?.diagnostics ?? diagnostics;
  const canReset = confirmText === RESET_CONFIRMATION && !busy && Boolean(api?.data);

  return (
    <>
      <ViewHead title="설정" subtitle="표시 취향은 브라우저에, 수집·자격증명은 서비스(SQLite)에 저장됩니다" />

      <div className="two-col settings-cols">
        <div className="view-stack">
          <section className="panel">
            <div className="panel-head"><div><h2>일반 <span>••</span></h2><p className="panel-sub">이 브라우저에만 저장 (localStorage)</p></div></div>
            <p className="settings-label">고양이 스킨</p>
            <div className="skin-grid settings-skin-grid">
              {catThemes.map((theme) => (
                <button type="button" key={theme.id} className={`skin-option${catTheme === theme.id ? ' selected' : ''}`} aria-pressed={catTheme === theme.id} onClick={() => onSelectTheme(theme.id)}>
                  <span className={`skin-cat theme-${theme.id}`}><CatArt pose="face" decorative /></span>
                  <span><strong>{theme.label}</strong><small>{theme.hint}</small></span>
                  <i aria-hidden="true">✓</i>
                </button>
              ))}
            </div>
            <div className="kv"><span>집계 기준</span><strong>월 · 로컬 시간대 <em className="milestone-pill">기간 옵션 — M2</em></strong></div>
            <div className="kv"><span>숫자 표기</span><strong>약식 (319.6M)</strong></div>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>provider 자격증명</h2><p className="panel-sub">공식 API 키만, 사용자가 직접 입력합니다. 다른 앱의 쿠키·키체인은 읽지 않습니다.</p></div><MilestonePill id="M6" /></div>
            <div className="kv"><span>Cursor Admin API 키</span><strong>미설정</strong></div>
            <p className="filter-note">키는 서비스가 SQLite에 저장하고, 어떤 HTTP 응답에도 값이 되돌아가지 않습니다(설정 여부만 표시). 개인 계정은 Admin API 대상이 아니라 대시보드 CSV 내보내기 → 가져오기(M7) 경로를 안내합니다.</p>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>텔레메트리 (선택)</h2><p className="panel-sub">Claude Code OTLP 수신으로 서브에이전트 사용량 분리 — JSONL 레인을 덮어쓰지 않습니다</p></div><MilestonePill id="M3" /></div>
            <pre className="code-box">{`CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<서비스 배정 포트>`}</pre>
          </section>
        </div>

        <div className="view-stack">
          <section className="panel">
            <div className="panel-head"><div><h2>데이터 <span>••</span></h2><p className="panel-sub">서비스 프로세스가 소유합니다</p></div></div>
            <div className="kv"><span>SQLite 위치</span><strong>{counters?.dbPath ?? '서비스 연결 대기'}</strong></div>
            <div className="kv"><span>서비스 주소</span><strong>{serviceUrl ? `${serviceUrl} · 루프백 전용` : '웹 미리보기 모드'}</strong></div>
            {counters ? (
              <div className="kv"><span>담긴 것</span><strong>
                사용량 {counters.usageEvents.toLocaleString('ko-KR')}건 · 세션 {counters.sessions.toLocaleString('ko-KR')}개 · 스캔한 파일 {counters.scanFiles.toLocaleString('ko-KR')}개
              </strong></div>
            ) : null}
            <div className="settings-actions">
              <button type="button" className="chip-button" onClick={onBackup} disabled={!api?.data || Boolean(busy)}>
                {busy === 'backup' ? '백업 중…' : '백업 만들기'}
              </button>
              <button type="button" className="chip-button" disabled title="M7에서 제공">원장 내보내기</button>
              <button type="button" className="chip-button" disabled title="M7에서 제공">가져오기</button>
              <MilestonePill id="M7" />
            </div>
            {notice ? <p className="settings-notice">{notice}</p> : null}
            {failure ? <p className="settings-failure">{failure}</p> : null}
            <p className="filter-note">포트·데이터 경로는 환경변수(NYANG_PORT · NYANG_USER_DATA)로만 바꿀 수 있어 읽기 전용으로 표시합니다.</p>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>백업 <span>••</span></h2><p className="panel-sub">{data?.backupDir ?? '서비스 연결 대기'}</p></div></div>
            {data?.backups?.length ? (
              <div className="backup-list">
                {data.backups.map((item) => (
                  <div className="kv" key={item.name}>
                    <span>{item.name}</span>
                    <strong>{formatBytes(item.sizeBytes)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="planned-copy">{data ? '아직 백업이 없어요.' : '서비스에서 목록을 받는 중이에요.'}</p>
            )}
            <p className="filter-note">
              백업은 서비스가 <code>VACUUM INTO</code> 로 만듭니다 — 수집 중에도 찢어지지 않은 사본이 나옵니다.
              <strong> 백업 파일에는 가려지지 않은 원본 프로젝트 경로가 들어 있습니다.</strong>{' '}
              경로 가림은 화면에 보여줄 때 적용하는 규칙이고 저장은 원본이라, 백업 파일을 남에게 주는 것은 경로를 주는 것과 같습니다.
            </p>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>로컬 데이터 초기화 <span>••</span></h2><p className="panel-sub">원장을 비우고 로그에서 처음부터 다시 잽니다</p></div></div>
            <p className="planned-copy">
              측정값은 <strong>파생값</strong>입니다 — 원본은 각 도구의 로컬 로그이고, 비운 뒤 다시 스캔하면 같은 값이 다시 나옵니다.
              다만 그 사이 로그가 지워진 구간은 돌아오지 않습니다.
            </p>
            <label className="settings-check">
              <input type="checkbox" checked={keepAliases} onChange={(event) => setKeepAliases(event.target.checked)} />
              <span>프로젝트 별칭·경로 가림은 남기기 <small>사람이 손으로 만든 것이라 다시 스캔해도 복원되지 않습니다</small></span>
            </label>
            <p className="settings-label">되돌릴 수 없어요. 진행하려면 <code>{RESET_CONFIRMATION}</code> 을 입력하세요.</p>
            <div className="settings-actions">
              <input
                className="search-input"
                type="text"
                value={confirmText}
                placeholder={RESET_CONFIRMATION}
                aria-label="초기화 확인 문자열"
                onChange={(event) => setConfirmText(event.target.value)}
              />
              <button type="button" className="chip-button danger" onClick={onReset} disabled={!canReset}>
                {busy === 'reset' ? '비우는 중…' : '초기화하고 다시 재기'}
              </button>
            </div>
            <p className="filter-note">초기화 전에 백업을 자동으로 만듭니다. 백업이 실패하면 <strong>비우지 않습니다.</strong></p>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>프로젝트 별칭 · 가림</h2><p className="panel-sub">가림을 켜면 서비스가 스냅샷에서 원본 경로를 제거합니다</p></div><MilestonePill id="M2" /></div>
            <p className="planned-copy">별칭과 경로 가림은 <strong>프로젝트 화면</strong>에서 프로젝트마다 켭니다. 원본 경로는 로컬 SQLite에만 남고, 스냅샷에서는 서비스가 지웁니다 — 다만 위 백업 파일에는 들어갑니다.</p>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>정보 <span>••</span></h2></div></div>
            <div className="kv"><span>버전</span><strong>{pkg.version}</strong></div>
            <div className="kv"><span>수집 provider</span><strong>{connected.map((provider) => provider.name).join(' · ') || '없음'} ({connected.length}/{providers.length || 4})</strong></div>
            <div className="kv"><span>가격 데이터</span><strong>미구성 — M7</strong></div>
          </section>
        </div>
      </div>
    </>
  );
}
