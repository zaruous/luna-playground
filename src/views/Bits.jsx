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
