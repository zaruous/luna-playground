import CatArt from '../CatArt.jsx';
import { ViewHead, MilestonePill } from './Bits.jsx';
import { catThemes } from '../shared.js';
import pkg from '../../package.json';

export default function SettingsView({ snapshot, catTheme, onSelectTheme }) {
  const diagnostics = snapshot?.diagnostics ?? null;
  const providers = snapshot?.providers ?? [];
  const connected = providers.filter((provider) => provider.integration === 'connected');
  const serviceUrl = window.__NYANG_TRACKER_CONFIG__?.transport?.baseUrl ?? null;

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
            <div className="kv"><span>SQLite 위치</span><strong>{diagnostics?.dbPath ?? '서비스 연결 대기'}</strong></div>
            <div className="kv"><span>서비스 주소</span><strong>{serviceUrl ? `${serviceUrl} · 루프백 전용` : '웹 미리보기 모드'}</strong></div>
            <div className="settings-actions">
              <button type="button" className="chip-button" disabled title="M7에서 제공">원장 내보내기</button>
              <button type="button" className="chip-button" disabled title="M7에서 제공">가져오기</button>
              <button type="button" className="chip-button danger" disabled title="M7에서 제공">전체 삭제</button>
              <MilestonePill id="M7" />
            </div>
            <p className="filter-note">포트·데이터 경로는 환경변수(NYANG_PORT · NYANG_USER_DATA)로만 바꿀 수 있어 읽기 전용으로 표시합니다.</p>
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>프로젝트 별칭 · 가림</h2><p className="panel-sub">가림을 켜면 서비스가 스냅샷에서 원본 경로를 제거합니다</p></div><MilestonePill id="M2" /></div>
            <p className="planned-copy"><code>project_aliases</code> 테이블과 함께 M2에서 제공됩니다. 원본 경로는 로컬 SQLite에만 남습니다.</p>
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
