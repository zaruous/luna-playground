import { useMemo, useState } from 'react';
import newsData from './data/news.json';

const categories = ['전체', '정치', '경제', '사회', '세계', 'IT·과학', '문화·스포츠', '종합'];

function formatDate(dateString, options = {}) {
  if (!dateString) return '업데이트 대기';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', ...options }).format(new Date(dateString));
}

function relativeTime(dateString) {
  if (!dateString) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(dateString).getTime()) / 60000));
  if (minutes < 1) return '방금 전';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : formatDate(dateString, { month: 'numeric', day: 'numeric' });
}

function downloadMarkdown(items) {
  const stamp = newsData.date || new Date().toISOString().slice(0, 10);
  const lines = [
    `# NewsTrend — ${stamp}`,
    '',
    `> 생성 시각: ${formatDate(newsData.generatedAt, { dateStyle: 'long', timeStyle: 'short' })}`,
    `> 기준: ${newsData.feed}`,
    '',
    ...items.flatMap((item) => [
      `## ${item.rank}. ${item.title}`,
      '',
      `- 카테고리: ${item.category}`,
      `- 출처: ${item.source}`,
      `- 게시: ${formatDate(item.publishedAt, { dateStyle: 'medium', timeStyle: 'short' })}`,
      `- 원문: ${item.url}`,
      '',
    ]),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `newstrend-${stamp}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function DownloadIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function StoryCard({ story, featured = false }) {
  return (
    <article className={`story-card ${featured ? 'story-card--featured' : ''}`}>
      <div className="story-card__topline">
        <span className="rank">{String(story.rank).padStart(2, '0')}</span>
        <span className="category">{story.category}</span>
        <span className="time">{relativeTime(story.publishedAt)}</span>
      </div>
      <h2>{story.title}</h2>
      <div className="story-card__footer">
        <div className="source-block"><span className="source-dot" /><span>{story.source}</span></div>
        <a href={story.url} target="_blank" rel="noreferrer" className="story-link">원문 보기 <ArrowIcon /></a>
      </div>
    </article>
  );
}

export default function App() {
  const [category, setCategory] = useState('전체');
  const [query, setQuery] = useState('');

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return newsData.items.filter((item) => {
      const categoryMatches = category === '전체' || item.category === category;
      const queryMatches = !normalized || `${item.title} ${item.source}`.toLowerCase().includes(normalized);
      return categoryMatches && queryMatches;
    });
  }, [category, query]);

  const featured = visibleItems[0];
  const rest = visibleItems.slice(1);
  const dateLabel = newsData.generatedAt ? formatDate(newsData.generatedAt, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) : '뉴스 업데이트 대기';

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="./" aria-label="NewsTrend 홈"><span className="brand-mark">N</span><span>NEWSTREND</span></a>
        <div className="header-meta"><span>SEOUL · KST</span><span className="live-dot" /><span>{newsData.items.length ? 'LIVE EDITION' : 'WAITING FOR FEED'}</span></div>
      </header>
      <main>
        <section className="hero">
          <p className="eyebrow">TODAY'S SIGNAL</p>
          <div className="hero-grid">
            <div><h1>오늘의 흐름을<br />한 장에.</h1><p className="hero-copy">당일 주요 뉴스 약 20개를 순위로 정리합니다.<br />궁금한 기사는 원문에서, 필요한 목록은 Markdown으로.</p></div>
            <div className="edition-panel"><div className="edition-number">{String(newsData.items.length).padStart(2, '0')}</div><div><span className="edition-label">STORIES</span><strong>{dateLabel}</strong><small>마지막 갱신 {formatDate(newsData.generatedAt, { hour: '2-digit', minute: '2-digit' })}</small></div></div>
          </div>
        </section>
        <section className="toolbar" aria-label="뉴스 필터">
          <div className="category-scroll">{categories.map((item) => <button type="button" key={item} className={category === item ? 'chip chip--active' : 'chip'} onClick={() => setCategory(item)}>{item}</button>)}</div>
          <div className="toolbar-actions">
            <label className="search-field"><span className="sr-only">뉴스 검색</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목·언론사 검색" /><span>⌕</span></label>
            <button type="button" className="download-button" onClick={() => downloadMarkdown(visibleItems)} disabled={!visibleItems.length}><DownloadIcon /> Markdown</button>
          </div>
        </section>
        {featured ? <section className="news-layout"><div className="section-heading"><span>RANKING</span><p>{visibleItems.length}개의 뉴스 · Google News Top Stories 기준</p></div><StoryCard story={featured} featured /><div className="story-grid">{rest.map((story) => <StoryCard key={story.id} story={story} />)}</div></section> : <section className="empty-state"><span>NO SIGNAL</span><h2>조건에 맞는 뉴스가 없습니다.</h2><p>검색어를 지우거나 다른 카테고리를 선택해보세요.</p></section>}
      </main>
      <footer><div><strong>NEWSTREND</strong><span>News belongs to its original publishers.</span></div><p>Google News RSS의 당일 노출 순서를 정리하며, 기사 내용은 저장하지 않고 제목·출처·원문 링크만 제공합니다.</p></footer>
    </div>
  );
}
