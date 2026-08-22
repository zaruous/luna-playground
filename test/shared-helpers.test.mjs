import test from 'node:test';
import assert from 'node:assert/strict';
import { promptSideTokens } from '../service/providers/accounting.mjs';
import {
  buildChartColumns, buildProviderTokenSplits, cacheHitPercent, connectionState, decomposeTokens,
  featuredQuotaWindow, formatPercent, providerQuotaWindows, reconcileCopy, resolvePeriodBreakdown,
  sumTokenFields, serverQuotaState,
} from '../src/shared.js';

// 회계가 서로 반대인 두 provider 를 나란히 둡니다. 한쪽에서만 참인 식은 다른
// 쪽에서 터지므로, 픽스처가 한 종류뿐이면 이 파일이 잡으려는 거짓말이 통과합니다.
// 숫자 모양은 service/engine.mjs snapshot 이 내려주는 totals 그대로입니다.
const codexTotals = {
  // cache_in_input: cachedInputTokens 6000 은 inputTokens 8000 **안에** 있습니다.
  inputTokens: 8000, cachedInputTokens: 6000, cacheWriteInputTokens: 1000,
  outputTokens: 500, reasoningTokens: 200, totalTokens: 8500, promptTokens: 9000,
};
const claudeTotals = {
  // cache_disjoint: 캐시 읽기 9000 은 input 10 **밖에** 있습니다. 이 극단적인
  // 비율은 실제 코퍼스 모양입니다 — 캐시가 붙은 긴 대화의 후속 턴이 이렇습니다.
  inputTokens: 10, cachedInputTokens: 9000, cacheWriteInputTokens: 500,
  outputTokens: 200, reasoningTokens: 0, totalTokens: 9710, promptTokens: 9510,
};
// 대시보드 합계 카드가 받는 값(sumTokenTotals). 필드별 단순 합입니다.
const mergedTotals = {
  inputTokens: 8010, cachedInputTokens: 15000, cacheWriteInputTokens: 1500,
  outputTokens: 700, reasoningTokens: 200, totalTokens: 18210, promptTokens: 18510,
};

test('캐시 적중률의 분모는 inputTokens 가 아니라 promptTokens 다', () => {
  // 픽스처의 promptTokens 가 엔진이 실제로 계산해 내려주는 값과 같은지 먼저
  // 못박습니다. 여기가 어긋나면 아래 비율은 화면이 아니라 픽스처를 검사하게 됩니다.
  assert.equal(codexTotals.promptTokens, promptSideTokens('codex', codexTotals));
  assert.equal(claudeTotals.promptTokens, promptSideTokens('claude', claudeTotals));

  // cache_disjoint 에서 순진한 cached/input 은 90000% 를 냅니다. 백분율이 100 을
  // 넘는 순간 그건 캐시 적중률이 아니라 그냥 잘못된 나눗셈입니다.
  const claudeNaive = (claudeTotals.cachedInputTokens / claudeTotals.inputTokens) * 100;
  assert.equal(claudeNaive, 90000, '픽스처가 순진한 식을 폭발시키지 못했습니다');
  const claudePercent = cacheHitPercent(claudeTotals);
  assert.notEqual(claudePercent, claudeNaive);
  assert.ok(claudePercent <= 100, `적중률이 100% 를 넘었습니다: ${claudePercent}`);
  assert.equal(claudePercent, (9000 / 9510) * 100);
  assert.equal(formatPercent(claudePercent), '95%');

  // cache_in_input 쪽은 순진한 식이 터지지 않습니다 — 그래서 더 위험합니다.
  // 75% 는 그럴듯해 보이지만 분모에서 캐시 쓰기를 빼먹은 다른 수입니다.
  const codexNaive = (codexTotals.cachedInputTokens / codexTotals.inputTokens) * 100;
  assert.equal(codexNaive, 75);
  assert.equal(cacheHitPercent(codexTotals), (6000 / 9000) * 100);
  assert.equal(formatPercent(cacheHitPercent(codexTotals)), '67%');

  // promptTokens 는 provider 안에서 겹치지 않게 만들어진 값이라 합산이 됩니다.
  // 그래서 합계 카드의 적중률도 100% 를 넘지 않습니다(R4).
  assert.equal(mergedTotals.promptTokens, codexTotals.promptTokens + claudeTotals.promptTokens);
  assert.ok(cacheHitPercent(mergedTotals) <= 100);
});

test('잰 적 없는 캐시 적중률은 0% 가 아니라 null 이다', () => {
  // 0% 는 "캐시를 하나도 못 맞췄다"는 관측 결과입니다. 아직 아무 이벤트도 없는
  // 상태에 그 문장을 찍으면 화면이 재본 적 없는 것을 말하게 됩니다(R7).
  const empty = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, totalTokens: 0, promptTokens: 0 };
  assert.equal(cacheHitPercent(empty), null);
  assert.notEqual(cacheHitPercent(empty), 0);
  assert.equal(formatPercent(cacheHitPercent(empty)), '—');

  // promptTokens 를 아예 안 실어 보내는 옛 응답도 "0%" 가 아니라 "모름" 입니다.
  assert.equal(cacheHitPercent({ inputTokens: 100, cachedInputTokens: 40 }), null);
  assert.equal(cacheHitPercent(null), null);
  assert.equal(cacheHitPercent(undefined), null);

  // 반대로 진짜로 재서 0 이면 0 입니다 — null 로 뭉개면 관측 결과를 지웁니다.
  const measuredZero = { inputTokens: 1200, cachedInputTokens: 0, cacheWriteInputTokens: 0, promptTokens: 1200 };
  assert.equal(cacheHitPercent(measuredZero), 0);
  assert.equal(formatPercent(cacheHitPercent(measuredZero)), '0%');
});

test('formatPercent 는 못 잰 값과 잰 0 을 다른 글자로 적는다', () => {
  // Number(null) 은 0 이라 isFinite 만으로는 이 둘이 같은 글자가 됩니다.
  assert.equal(formatPercent(null), '—');
  assert.notEqual(formatPercent(null), '0%');
  assert.equal(formatPercent(undefined), '—');
  assert.equal(formatPercent(NaN), '—');

  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0, 1), '0.0%');
  assert.equal(formatPercent(66.666), '67%');
  assert.equal(formatPercent(66.666, 1), '66.7%');
});

test('서버 한도 상태 네 가지는 서로 다른 사실이다', () => {
  // 실제 어댑터 capabilities 모양(service/providers/*/collector.mjs).
  const observed = {
    id: 'codex', name: 'Codex', integration: 'connected',
    capabilities: { localLedger: true, serverQuota: true, hooks: true },
    quotaWindows: [{ windowType: 'primary', windowMinutes: 300, usedPercent: 42, limitId: 'codex' }],
  };
  const waiting = { ...observed, quotaWindows: [], rateLimits: { limits: [], primary: null, secondary: null } };
  // Claude 는 JSONL 에 한도를 남기지 않습니다 — 영영 오지 않을 snapshot 입니다.
  const none = {
    id: 'claude', name: 'Claude', integration: 'connected',
    capabilities: { localLedger: true, serverQuota: false, hooks: true }, quotaWindows: [],
  };
  // 어댑터가 아직 없는 provider 는 capabilities 자체가 null 입니다(registry describe).
  const planned = { id: 'cursor', name: 'Cursor', integration: 'planned', capabilities: null };

  assert.deepEqual(serverQuotaState(observed), { state: 'observed', label: null });
  assert.deepEqual(serverQuotaState(waiting), { state: 'waiting', label: 'snapshot 대기' });
  assert.deepEqual(serverQuotaState(none), { state: 'none', label: '한도 미제공' });
  assert.deepEqual(serverQuotaState(planned), { state: 'planned', label: '미연결' });

  // 네 상태가 실제로 네 개여야 화면이 이 넷을 구분해 말할 수 있습니다.
  assert.equal(new Set([observed, waiting, none, planned].map((row) => serverQuotaState(row).state)).size, 4);

  // !provider.capabilities?.serverQuota 한 줄로 합치면 planned 와 none 이 같은
  // 가지로 떨어집니다 — 한 번도 관측한 적 없는 provider 에 "이 provider 는 서버
  // 한도를 기록하지 않습니다" 라는 없는 사실을 붙이게 됩니다(R7).
  assert.notEqual(serverQuotaState(planned).state, serverQuotaState(none).state);
  assert.notEqual(serverQuotaState(planned).label, '한도 미제공');
  // capabilities 가 null 인 행에서 quotaWindows 를 읽다 터지지도 않아야 합니다.
  assert.doesNotThrow(() => serverQuotaState(planned));
  assert.equal(serverQuotaState(undefined).state, 'planned');
  assert.equal(serverQuotaState({ id: 'gemini' }).state, 'planned');

  // 화면은 'observed' 인 행에서만 window.usedPercent 를 바로 읽습니다. 두 함수가
  // 같은 목록을 보고 있어야 그 접근이 안전합니다 — 판단 기준이 갈리면 카드가
  // 숫자를 못 찍는 게 아니라 통째로 터집니다.
  assert.notEqual(featuredQuotaWindow(observed), null);
  for (const row of [waiting, none, planned]) assert.equal(featuredQuotaWindow(row), null);
});

test('featuredQuotaWindow 는 남의 창을 고르지 않고, 없으면 만들지 않는다', () => {
  // 서버 원장 provider 가 둘이 되면 한 provider 의 quotaWindows 안에 다른
  // limitId 가 섞여 들어올 수 있습니다(store 는 limitId 를 정규화해 넣습니다).
  const codexWindow = { windowType: 'primary', windowMinutes: 300, usedPercent: 88, limitId: 'codex', limitName: 'Codex' };
  const cursorWindow = { windowType: 'primary', windowMinutes: 300, usedPercent: 12, limitId: 'cursor', limitName: 'Cursor Pro' };
  const cursorWeekly = { windowType: 'secondary', windowMinutes: 10080, usedPercent: 30, limitId: 'cursor', limitName: 'Cursor Pro' };
  const cursor = { id: 'cursor', name: 'Cursor', quotaWindows: [codexWindow, cursorWindow, cursorWeekly] };

  // 'codex' 리터럴로 고르면 88% 짜리 남의 창이 Cursor 카드에 올라갑니다.
  assert.equal(featuredQuotaWindow(cursor), cursorWindow);
  assert.notEqual(featuredQuotaWindow(cursor).limitId, 'codex');
  // 고르는 것이지 만드는 것이 아닙니다 — 두 구독의 percent 를 섞은 새 값을
  // 내놓으면 공통 분모가 없는 수를 지어내는 것입니다(R5).
  assert.ok(cursor.quotaWindows.includes(featuredQuotaWindow(cursor)));

  // 내 limitId 짜리 5시간 창이 없으면 아무 5시간 창, 그것도 없으면 첫 창.
  assert.equal(featuredQuotaWindow({ id: 'gemini', quotaWindows: [cursorWeekly, codexWindow] }), codexWindow);
  assert.equal(featuredQuotaWindow({ id: 'gemini', quotaWindows: [cursorWeekly] }), cursorWeekly);
  // 관측한 창이 하나도 없으면 자리표시자가 아니라 null 입니다.
  assert.equal(featuredQuotaWindow({ id: 'codex', quotaWindows: [] }), null);
  assert.equal(featuredQuotaWindow(null), null);
});

test('providerQuotaWindows 는 quotaWindows 를 먼저 보고 rateLimits 로만 물러선다', () => {
  const flattened = [{ windowMinutes: 300, usedPercent: 5, limitId: 'codex' }];
  const primary = { windowType: 'primary', windowMinutes: 300, usedPercent: 61, limitId: 'codex' };
  const secondary = { windowType: 'secondary', windowMinutes: 10080, usedPercent: 22, limitId: 'codex' };

  // 엔진이 평탄화해 준 목록이 있으면 그쪽이 우선입니다.
  assert.deepEqual(providerQuotaWindows({ id: 'codex', quotaWindows: flattened, rateLimits: { primary, secondary } }), flattened);
  // 평탄화 목록이 없는 호출자(구버전 payload)는 primary/secondary 로 갑니다.
  assert.deepEqual(providerQuotaWindows({ id: 'codex', rateLimits: { primary, secondary } }), [primary, secondary]);
  // 둘 중 한쪽만 관측된 상태에서 null 이 창 하나로 세어지면 '관측함'이 됩니다.
  assert.deepEqual(providerQuotaWindows({ id: 'codex', rateLimits: { primary, secondary: null } }), [primary]);
  assert.deepEqual(providerQuotaWindows({ id: 'codex', quotaWindows: [], rateLimits: { limits: [], primary: null, secondary: null } }), []);
  assert.deepEqual(providerQuotaWindows({ id: 'claude' }), []);
  assert.deepEqual(providerQuotaWindows(null), []);
});

test('토큰 분해는 provider 회계별로만 겹치지 않고, 합계는 어느 회계로도 참이 아니다', () => {
  // Codex: input 이 캐시를 품고 있으므로 비캐시 입력은 input - cached 입니다.
  // 캐시 쓰기는 total 밖이라 조각이 아니라 extras 로 빠집니다.
  const codex = decomposeTokens(codexTotals);
  assert.equal(codex.nested, true);
  assert.equal(codex.sum, codexTotals.totalTokens);
  assert.equal(codex.segments.reduce((sum, segment) => sum + segment.value, 0), codexTotals.totalTokens);
  assert.deepEqual(codex.segments.map((segment) => [segment.key, segment.value]), [
    ['cachedInputTokens', 6000], ['inputTokens', 2000], ['outputTokens', 300], ['reasoningTokens', 200],
  ]);
  assert.deepEqual(codex.extras.map((extra) => [extra.key, extra.value, extra.note]), [['cacheWriteInputTokens', 1000, '합계 외']]);

  // Claude: 캐시 읽기·쓰기가 input 밖이자 total 안입니다 — input 은 깎지 않고,
  // 캐시 쓰기는 extras 가 아니라 막대 조각이 됩니다.
  const claude = decomposeTokens(claudeTotals);
  assert.equal(claude.nested, true);
  assert.equal(claude.segments.reduce((sum, segment) => sum + segment.value, 0), claudeTotals.totalTokens);
  assert.deepEqual(claude.segments.map((segment) => [segment.key, segment.value]), [
    ['cachedInputTokens', 9000], ['cacheWriteInputTokens', 500], ['inputTokens', 10], ['outputTokens', 200], ['reasoningTokens', 0],
  ]);
  assert.deepEqual(claude.extras, []);

  // 합계를 그대로 먹이면 두 항등식 중 어느 것도 성립하지 않아 fallback 으로
  // 떨어집니다. fallback 의 합(25,410)은 실제 totalTokens(18,210)와 다릅니다 —
  // 추론이 출력 안에 있고 캐시가 한쪽 input 안에만 있어 이중으로 세이기 때문입니다.
  // 그래서 대시보드는 합계 한 줄이 아니라 provider 마다 한 줄을 그립니다(R4).
  const merged = decomposeTokens(mergedTotals);
  assert.equal(merged.nested, false);
  assert.notEqual(merged.sum, mergedTotals.totalTokens);
  assert.equal(merged.sum, 25410);
  // 합쳐진 inputTokens 8,010 은 캐시를 포함한 8,000 과 포함하지 않은 10 의 합이라
  // 두 회계 어느 쪽으로도 "입력"이 아닙니다.
  assert.equal(merged.segments.find((segment) => segment.key === 'inputTokens').value, 8010);

  // 아직 아무것도 안 쟀으면 조각이 아니라 0 짜리 fallback 입니다 — 화면은 이 경우
  // 막대 대신 "분해할 토큰이 없다"고 적어야 합니다.
  const emptySplit = decomposeTokens({});
  assert.equal(emptySplit.nested, false);
  assert.equal(emptySplit.sum, 0);
});

test('대조 문구는 자기 이름이 아닌 provider 를 대신 말하지 않는다', () => {
  const [cursorTitle, cursorBody] = reconcileCopy({ status: 'UNATTRIBUTED_SERVER_USAGE' }, 'Cursor');
  assert.match(cursorBody, /로컬 Cursor 로그/);
  assert.doesNotMatch(`${cursorTitle} ${cursorBody}`, /Codex|rollout/);
  assert.match(reconcileCopy({ status: 'SYNCED' }, 'Cursor')[0], /^Cursor /);

  // 이름을 못 받았으면 지어내지 않고 문장에서 뺍니다(R7).
  const [anonTitle, anonBody] = reconcileCopy(null);
  assert.doesNotMatch(`${anonTitle} ${anonBody}`, /Codex|rollout/);
  assert.doesNotMatch(anonTitle, /provider|프로바이더/);

  // 이름이 없다는 건 "서버 원장을 가진 provider 가 하나도 없다"는 뜻입니다.
  // 그 상태에서 "snapshot 이 들어오면 대조합니다"는 지킬 수 없는 약속이라,
  // 이름이 있을 때와 없을 때의 본문이 서로 달라야 합니다.
  const [, namedBody] = reconcileCopy(null, 'Codex');
  assert.match(namedBody, /snapshot이 들어오면/);
  assert.doesNotMatch(anonBody, /들어오면/);
  assert.match(anonBody, /서버 한도 원장을 주는 곳이 없어요/);
});

test('기간 합계는 provider 합산 fallback 을 화면에 내지 않는다', () => {
  const merged = sumTokenFields([{ tokens: codexTotals }, { tokens: claudeTotals }]);
  const mergedDecomposed = decomposeTokens(merged);
  assert.equal(mergedDecomposed.nested, false);
  assert.notEqual(mergedDecomposed.sum, merged.totalTokens);

  const splits = buildProviderTokenSplits(
    [
      { id: 'codex', name: 'Codex', tokenAccounting: 'cache_in_input' },
      { id: 'claude', name: 'Claude', tokenAccounting: 'cache_disjoint' },
    ],
    new Map([['codex', codexTotals], ['claude', claudeTotals]]),
  );
  for (const split of splits) {
    assert.equal(split.nested, true);
    assert.equal(split.sum, split.id === 'codex' ? codexTotals.totalTokens : claudeTotals.totalTokens);
    assert.equal(split.segments.reduce((sum, segment) => sum + segment.value, 0), split.sum);
  }

  const resolved = resolvePeriodBreakdown({
    providerFilter: 'all',
    splits,
    mergedDecomposed,
    totalTokens: merged.totalTokens,
  });
  assert.equal(resolved.layout, 'providers');
  assert.equal(resolved.categories, null);
  assert.match(resolved.notice, /provider마다/);
});

test('단일 provider 기간에서 nested false 면 조각 합 경고를 낸다', () => {
  const codexUndecomposable = { inputTokens: 0, outputTokens: 0, totalTokens: 9610 };
  const decomposed = decomposeTokens(codexUndecomposable);
  assert.equal(decomposed.nested, false);
  assert.notEqual(decomposed.sum, codexUndecomposable.totalTokens);

  const resolved = resolvePeriodBreakdown({
    providerFilter: 'codex',
    splits: buildProviderTokenSplits(
      [{ id: 'codex', name: 'Codex', tokenAccounting: 'cache_in_input' }],
      new Map([['codex', codexUndecomposable]]),
    ),
    mergedDecomposed: decomposed,
    totalTokens: codexUndecomposable.totalTokens,
  });
  assert.equal(resolved.layout, 'categories');
  assert.match(resolved.notice, /조각 합|겹침/);
});

test('차트 열은 totalTokens 기준이고 nested false 슬라이스는 remainder 로 남긴다', () => {
  const columns = buildChartColumns([
    { bucketStart: '2026-08-01', provider: 'codex', tokens: codexTotals },
    { bucketStart: '2026-08-01', provider: 'claude', tokens: claudeTotals },
    { bucketStart: '2026-08-02', provider: 'codex', tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 9610 } },
  ]);
  const mergedDay = columns.find((column) => column.bucketStart === '2026-08-01');
  assert.equal(mergedDay.totalTokens, codexTotals.totalTokens + claudeTotals.totalTokens);
  assert.equal(mergedDay.nested, true);
  assert.equal(
    mergedDay.segments.reduce((sum, segment) => sum + segment.value, 0),
    codexTotals.totalTokens + claudeTotals.totalTokens,
  );

  const undecomposableDay = columns.find((column) => column.bucketStart === '2026-08-02');
  assert.equal(undecomposableDay.approximate, true);
  assert.equal(undecomposableDay.remainder, 9610);
  assert.equal(undecomposableDay.totalTokens, 9610);
});

test('connectionState 는 401 과 그 밖의 실패와 EventSource 오류를 구분한다', () => {
  const stale = connectionState({ error: { status: 401 } });
  assert.equal(stale.kind, 'stale-auth');
  assert.match(stale.message, /새로고침/);

  const unreachable = connectionState({ error: { status: 503 } });
  assert.equal(unreachable.kind, 'unreachable');
  assert.notEqual(unreachable.message, stale.message);

  const eventError = connectionState({ error: { type: 'error' } });
  assert.equal(eventError.kind, 'unreachable');

  const live = connectionState({ error: null });
  assert.equal(live.kind, 'live');
  assert.equal(live.message, null);
});
