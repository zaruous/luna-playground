import { useEffect, useRef, useState } from 'react';

export function ViewHead({ title, subtitle, children }) {
  return (
    <div className="view-head">
      <div><h2>{title}</h2><p>{subtitle}</p></div>
      {children ? <div className="view-head-actions">{children}</div> : null}
    </div>
  );
}

export function MilestonePill({ id }) {
  return <span className="milestone-pill">준비 중 — {id}</span>;
}

// 스냅샷 시각을 그대로 useEffect 의존성에 넣으면, provider 로그가 활발히
// 기록되는 동안 SSE 가 초당 여러 번 스냅샷을 밀어 REST 요청이 응답 전에
// 계속 취소됩니다 — 목록이 영원히 비어 보입니다(실제로 겪었습니다).
//
// 그래서 "느린 시계"를 만들어 씁니다. 값은 최대 intervalMs 마다 한 번만
// 바뀌므로 요청이 완주할 시간이 생깁니다. 필터 변경은 별개 의존성이라
// 즉시 반영됩니다 — 문서가 정한 "필터가 바뀔 때만 당긴다"와 같은 방향입니다.
export function useSlowStamp(stamp, intervalMs = 15_000) {
  const [slow, setSlow] = useState(stamp ?? null);
  const lastAt = useRef(0);
  const pending = useRef(null);

  useEffect(() => {
    if (stamp == null) return undefined;
    pending.current = stamp;
    const elapsed = Date.now() - lastAt.current;
    if (elapsed >= intervalMs) {
      lastAt.current = Date.now();
      setSlow(stamp);
      return undefined;
    }
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setSlow(pending.current);
    }, intervalMs - elapsed);
    return () => clearTimeout(timer);
  }, [stamp, intervalMs]);

  return slow;
}
