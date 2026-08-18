import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FEED_URL = 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko';
export const TIME_ZONE = 'Asia/Seoul';

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

export function parseFeed(xml, now = new Date()) {
  const today = dateKey(now);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
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
      };
    })
    .filter((item) => item.url && item.title && item.publishedAt)
    .filter((item) => dateKey(new Date(item.publishedAt)) === today)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.title === item.title) === index)
    .slice(0, 20)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  return {
    generatedAt: now.toISOString(),
    date: today,
    feed: 'Google News Korea Top Stories',
    items,
  };
}

export async function refreshNews({ fetchImpl = fetch, now = new Date(), output } = {}) {
  const response = await fetchImpl(FEED_URL, {
    headers: {
      'user-agent': 'NewsTrend/0.1 (+https://github.com/zaruous/luna-playground)',
      accept: 'application/rss+xml, application/xml, text/xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Google News RSS request failed: ${response.status} ${response.statusText}`);
  }

  const payload = parseFeed(await response.text(), now);
  if (payload.items.length === 0) {
    throw new Error(`No same-day news found for ${payload.date} (${TIME_ZONE})`);
  }

  const target = output ?? resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/news.json');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const payload = await refreshNews();
  console.log(`NewsTrend: wrote ${payload.items.length} stories for ${payload.date}`);
}
