import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIME_ZONE = 'Asia/Seoul';
export const FEEDS = [
  { name: 'Top Stories', url: 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko' },
  { name: 'Politics', url: 'https://news.google.com/rss/search?q=%EC%A0%95%EC%B9%98&hl=ko&gl=KR&ceid=KR:ko' },
  { name: 'Economy', url: 'https://news.google.com/rss/search?q=%EA%B2%BD%EC%A0%9C&hl=ko&gl=KR&ceid=KR:ko' },
  { name: 'Society', url: 'https://news.google.com/rss/search?q=%EC%82%AC%ED%9A%8C&hl=ko&gl=KR&ceid=KR:ko' },
  { name: 'World', url: 'https://news.google.com/rss/search?q=%EC%84%B8%EA%B3%84&hl=ko&gl=KR&ceid=KR:ko' },
  { name: 'Technology', url: 'https://news.google.com/rss/search?q=AI%20OR%20%EB%B0%98%EB%8F%84%EC%B2%B4%20OR%20IT&hl=ko&gl=KR&ceid=KR:ko' },
];

const categories = [
  ['IT·과학', /(AI|인공지능|반도체|로봇|우주|과학|기술|테크|스마트폰|애플|구글|네이버|카카오|삼성전자|SK하이닉스)/i],
  ['경제', /(증시|주가|코스피|코스닥|환율|금리|은행|부동산|아파트|경제|수출|관세|기업|산업|투자|재정|물가|고용)/i],
  ['세계', /(미국|중국|일본|러시아|우크라이나|유럽|EU|트럼프|해외|이스라엘|가자|북한|외교|정상회담)/i],
  ['정치', /(대통령|국회|민주당|국민의힘|장관|정부|정치|선거|특검|청와대|총리)/i],
  ['사회', /(경찰|검찰|법원|사고|폭염|태풍|날씨|의료|교육|범죄|재난|사회|노동|교통|산불)/i],
  ['문화·스포츠', /(야구|축구|스포츠|영화|드라마|가수|K팝|콘서트|문화|예능|올림픽|월드컵)/i],
];

export function decodeEntities(value = '') {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function clean(value = '') {
  return decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim());
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return clean(match?.[1] ?? '');
}

function source(block) {
  const match = block.match(/<source(?:\s+url="([^"]+)")?[^>]*>([\s\S]*?)<\/source>/i);
  return {
    url: decodeEntities(match?.[1] ?? ''),
    name: clean(match?.[2] ?? '') || '알 수 없음',
  };
}

export function dateKey(date, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function inferCategory(title) {
  return categories.find(([, pattern]) => pattern.test(title))?.[0] ?? '종합';
}

function trimSourceFromTitle(title, sourceName) {
  const suffix = ` - ${sourceName}`;
  return sourceName && title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

export function parseFeed(xml, now = new Date(), feedName = 'Google News') {
  const today = dateKey(now);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map((match) => {
      const block = match[1];
      const publisher = source(block);
      const rawTitle = tag(block, 'title');
      const publishedAt = new Date(tag(block, 'pubDate'));
      const link = tag(block, 'link');
      const title = trimSourceFromTitle(rawTitle, publisher.name);

      return {
        id: createHash('sha1').update(`${title}|${link}`).digest('hex').slice(0, 12),
        title,
        url: link,
        source: publisher.name,
        sourceUrl: publisher.url,
        publishedAt: Number.isNaN(publishedAt.valueOf()) ? null : publishedAt.toISOString(),
        category: inferCategory(title),
        feed: feedName,
      };
    })
    .filter((item) => item.url && item.title && item.publishedAt)
    .filter((item) => dateKey(new Date(item.publishedAt)) === today);
}

export function mergeFeedItems(feedItems, limit = 20) {
  return feedItems
    .flat()
    .filter((item, index, all) => all.findIndex((candidate) => candidate.title === item.title) === index)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function fetchFeed(feed, fetchImpl, now) {
  try {
    const response = await fetchImpl(feed.url, {
      headers: {
        'user-agent': 'NewsTrend/0.2 (+https://github.com/zaruous/luna-playground)',
        accept: 'application/rss+xml, application/xml, text/xml',
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return { feed, items: parseFeed(await response.text(), now, feed.name), error: null };
  } catch (error) {
    return { feed, items: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function refreshNews({ fetchImpl = fetch, now = new Date(), output, feeds = FEEDS } = {}) {
  const results = await Promise.all(feeds.map((feed) => fetchFeed(feed, fetchImpl, now)));
  const successfulFeeds = results.filter((result) => !result.error);
  const failedFeeds = results.filter((result) => result.error);
  const items = mergeFeedItems(successfulFeeds.map((result) => result.items));

  if (successfulFeeds.length === 0) {
    throw new Error(`All Google News feeds failed: ${failedFeeds.map((result) => `${result.feed.name}: ${result.error}`).join('; ')}`);
  }
  if (items.length === 0) {
    throw new Error(`No same-day news found for ${dateKey(now)} (${TIME_ZONE})`);
  }

  const payload = {
    generatedAt: now.toISOString(),
    date: dateKey(now),
    feed: 'Google News Korea multi-feed',
    feeds: successfulFeeds.map((result) => result.feed.name),
    failedFeeds: failedFeeds.map((result) => ({ name: result.feed.name, error: result.error })),
    items,
  };

  const target = output ?? resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/news.json');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const payload = await refreshNews();
  console.log(`NewsTrend: wrote ${payload.items.length} stories for ${payload.date} from ${payload.feeds.length}/${FEEDS.length} feeds`);
  if (payload.failedFeeds.length) console.warn(`NewsTrend: ${payload.failedFeeds.length} feed(s) failed; continuing with remaining feeds`);
}
