import { useMemo, useState } from 'react';
import { ViewHead, MilestonePill } from './Bits.jsx';
import { providerCatalog, formatTokens, relativeTime } from '../shared.js';

function projectKey(project, index) {
  return `${project.provider}-${project.name}-${project.cwd ?? index}`;
}

export default function ProjectView({ snapshot }) {
  const projects = snapshot?.projects ?? [];
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter((project) => `${project.name} ${project.cwd ?? ''}`.toLowerCase().includes(keyword));
  }, [projects, query]);

  const selected = filtered.find((project, index) => projectKey(project, index) === selectedKey) ?? filtered[0] ?? null;
  const selectedProvider = selected ? providerCatalog.find((item) => item.id === selected.provider) : null;

  return (
    <>
      <ViewHead title="프로젝트" subtitle="cwd 기준 자동 귀속 · 이번 달 토큰 상위 프로젝트" />

      {projects.length ? (
        <div className="project-layout">
          <section className="panel project-list-panel">
            <input
              className="search-input"
              type="search"
              placeholder="프로젝트 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="프로젝트 검색"
            />
            <div className="project-list">
              {filtered.map((project, index) => {
                const key = projectKey(project, index);
                const active = selected && projectKey(selected, filtered.indexOf(selected)) === key;
                return (
                  <button type="button" key={key} className={`project-item${active ? ' selected' : ''}`} onClick={() => setSelectedKey(key)}>
                    <strong>{project.name}</strong>
                    <small>{formatTokens(project.totalTokens)} · {providerCatalog.find((item) => item.id === project.provider)?.name ?? project.provider}</small>
                  </button>
                );
              })}
              {!filtered.length && <p className="filter-note">검색 결과가 없어요.</p>}
            </div>
            <p className="filter-note">Cursor는 Admin API가 프로젝트 정보를 주지 않아 이 목록에 나타나지 않습니다.</p>
          </section>

          <div className="view-stack">
            {selected ? (
              <section className="panel">
                <div className="panel-head">
                  <div><h2>{selected.name} <span>••</span></h2><p className="panel-sub">{selected.cwd || '경로 메타데이터 없음'}</p></div>
                  {selectedProvider ? <span className={`ai-mark ${selectedProvider.tone}`}>{selectedProvider.short}</span> : null}
                </div>
                <div className="stat-mini-grid">
                  <div className="stat-mini"><span>총 토큰</span><strong>{formatTokens(selected.totalTokens)}</strong></div>
                  <div className="stat-mini"><span>입력</span><strong className="mint-text">{formatTokens(selected.inputTokens)}</strong></div>
                  <div className="stat-mini"><span>캐시 읽기</span><strong className="violet-text">{formatTokens(selected.cachedInputTokens)}</strong></div>
                  <div className="stat-mini"><span>최근 활동</span><strong className="orange-text">{relativeTime(selected.lastActivity)}</strong></div>
                </div>
                <div className="kv"><span>주 사용 AI</span><strong>{selectedProvider?.name ?? selected.provider}</strong></div>
                <div className="kv"><span>최근 모델</span><strong>{selected.model ?? '—'}</strong></div>
              </section>
            ) : null}

            <section className="panel planned-panel">
              <div className="panel-head"><div><h2>세션 표 · 모델 분포 · 경로 가림</h2><p className="panel-sub">지금은 스냅샷의 이번 달 상위 6개만 표시합니다</p></div><MilestonePill id="M2" /></div>
              <p className="planned-copy">전체 목록·세션별 상세·별칭/가림 토글은 프로젝트 API(<code>GET /api/v1/projects</code>)와 <code>project_aliases</code> 테이블이 들어오는 M2에서 제공됩니다. 화면 설계: docs/dev/menus/project.md</p>
            </section>
          </div>
        </div>
      ) : (
        <section className="panel">
          <div className="empty-projects"><strong>아직 이번 달 프로젝트 기록이 없어요.</strong><span>연결된 provider 로그가 발견되면 cwd 기준으로 자동 분류합니다.</span></div>
        </section>
      )}
    </>
  );
}
