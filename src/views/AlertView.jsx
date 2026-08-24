import CatArt from '../CatArt.jsx';
import { ViewHead, MilestonePill } from './Bits.jsx';

const ruleKinds = [
  { kind: 'quota_percent', title: '한도 백분율 임계', copy: '서버 한도 snapshot이 지정한 창(5시간·주간)에서 임계 %를 넘으면 알립니다.' },
  { kind: 'token_budget', title: '토큰 예산', copy: '기간 내 로컬 관측 토큰 합계가 예산을 넘으면 알립니다.' },
  { kind: 'collector_stalled', title: '수집 중단 감지', copy: '수집기가 일정 시간 스캔하지 못하거나 오류 상태면 알립니다 — 조용히 멈춘 트래커는 0을 보여주며 거짓말을 하니까요.' },
];

export default function AlertView() {
  return (
    <>
      <ViewHead title="알림" subtitle="한도 · 예산 · 수집 중단 감지" />
      <section className="panel planned-panel alert-planned">
        <div className="panel-head"><div><h2>알림 규칙과 타임라인</h2><p className="panel-sub">규칙 저장·평가는 브라우저가 아니라 서비스 프로세스에서 — 탭을 닫아도 동작해야 하니까요</p></div><MilestonePill id="M4" /></div>
        <div className="rule-preview">
          {ruleKinds.map((rule) => (
            <div className="rule-preview-item" key={rule.kind}>
              <strong>{rule.title} <code>{rule.kind}</code></strong>
              <span>{rule.copy}</span>
            </div>
          ))}
        </div>
        <p className="planned-copy"><code>alert_rules</code>/<code>alert_events</code> 테이블과 <code>/api/v1/alerts</code> API가 들어오는 M4에서 규칙 관리·발생/해제 타임라인을 제공합니다. 화면 설계: docs/dev/menus/alert.md</p>
        <CatArt className="planned-cat" pose="sleep" decorative />
      </section>
    </>
  );
}
