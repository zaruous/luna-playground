import assert from 'node:assert/strict';
import test from 'node:test';
import { dateKey, inferCategory, mergeFeedItems, parseFeed, refreshNews } from './fetch-news.mjs';

const xml = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[AI 반도체 투자 확대 - 테스트경제]]></title><link>https://example.com/a</link><pubDate>Tue, 18 Aug 2026 23:10:00 GMT</pubDate><source url="https://example.com">테스트경제</source></item>
<item><title>국회 새 법안 논의 - 테스트뉴스</title><link>https://example.com/b</link><pubDate>Tue, 18 Aug 2026 22:20:00 GMT</pubDate><source url="https://example.com">테스트뉴스</source></item>
<item><title>어제 기사 - 테스트뉴스</title><link>https://example.com/c</link><pubDate>Tue, 18 Aug 2026 01:00:00 GMT</pubDate><source url="https://example.com">테스트뉴스</source></item>
</channel></rss>`;

test('dateKey converts UTC into Korean calendar day', () => {
  assert.equal(dateKey(new Date('2026-08-18T23:10:00Z')), '2026-08-19');
});

test('parseFeed keeps only same-day KST items', () => {
  const items = parseFeed(xml, new Date('2026-08-19T00:00:00Z'), 'test');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'AI 반도체 투자 확대');
  assert.equal(items[0].feed, 'test');
});

test('mergeFeedItems deduplicates, sorts newest first, and ranks', () => {
  const first = parseFeed(xml, new Date('2026-08-19T00:00:00Z'), 'first');
  const second = [{ ...first[0], feed: 'second' }];
  const merged = mergeFeedItems([first, second]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((item) => item.rank), [1, 2]);
  assert.equal(merged[0].title, 'AI 반도체 투자 확대');
});

test('refreshNews tolerates one failed feed when another succeeds', async () => {
  const feeds = [
    { name: 'good', url: 'https://good.test/rss' },
    { name: 'bad', url: 'https://bad.test/rss' },
  ];
  const fetchImpl = async (url) => {
    if (url.includes('bad')) return { ok: false, status: 503, statusText: 'Unavailable' };
    return { ok: true, text: async () => xml };
  };
  const payload = await refreshNews({
    fetchImpl,
    now: new Date('2026-08-19T00:00:00Z'),
    output: '/tmp/newstrend-test-news.json',
    feeds,
  });
  assert.equal(payload.items.length, 2);
  assert.deepEqual(payload.feeds, ['good']);
  assert.equal(payload.failedFeeds.length, 1);
});

test('category inference covers technology and politics', () => {
  assert.equal(inferCategory('AI 반도체 투자 확대'), 'IT·과학');
  assert.equal(inferCategory('국회 새 법안 논의'), '정치');
});
