import assert from 'node:assert/strict';
import test from 'node:test';
import { dateKey, inferCategory, parseFeed } from './fetch-news.mjs';

const xml = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[AI 반도체 투자 확대 - 테스트경제]]></title><link>https://example.com/a</link><pubDate>Tue, 18 Aug 2026 23:10:00 GMT</pubDate><source url="https://example.com">테스트경제</source></item>
<item><title>국회 새 법안 논의 - 테스트뉴스</title><link>https://example.com/b</link><pubDate>Tue, 18 Aug 2026 22:20:00 GMT</pubDate><source url="https://example.com">테스트뉴스</source></item>
<item><title>어제 기사 - 테스트뉴스</title><link>https://example.com/c</link><pubDate>Tue, 18 Aug 2026 01:00:00 GMT</pubDate><source url="https://example.com">테스트뉴스</source></item>
</channel></rss>`;

test('dateKey converts UTC into Korean calendar day', () => {
  assert.equal(dateKey(new Date('2026-08-18T23:10:00Z')), '2026-08-19');
});

test('parseFeed keeps only same-day KST items and ranks them', () => {
  const payload = parseFeed(xml, new Date('2026-08-19T00:00:00Z'));
  assert.equal(payload.items.length, 2);
  assert.deepEqual(payload.items.map((item) => item.rank), [1, 2]);
  assert.equal(payload.items[0].title, 'AI 반도체 투자 확대');
});

test('category inference covers technology and politics', () => {
  assert.equal(inferCategory('AI 반도체 투자 확대'), 'IT·과학');
  assert.equal(inferCategory('국회 새 법안 논의'), '정치');
});
