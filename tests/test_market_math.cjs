'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { annualReturns, buildBars, metrics, percentFrom, priceBounds } = require('../market-math.js');

function row(day, overrides = {}) {
  const result = { open: 10, high: 12, low: 9, close: 11, volume: 2, turnover: 22,
    tradeCount: 1, day, year: 1, month: 1, dayOfMonth: day, status: '实际成交', ...overrides };
  return { ...result, dateLabel: `第${result.year}年 ${result.month}月${result.dayOfMonth}日` };
}

function approximately(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * tolerance,
    `${actual} differs from ${expected}`);
}

test('loads as both CommonJS and a dependency-free defer-script global', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'market-math.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.YDAMarketMath).sort(), ['annualReturns', 'buildBars', 'metrics', 'percentFrom', 'priceBounds']);
  assert.equal(context.YDAMarketMath.percentFrom(11, 10), 10);
  assert.equal(globalThis.YDAMarketMath.buildBars, buildBars);
});

test('daily bars copy rows, retain zero-volume dates and never mutate the source', () => {
  const input = Object.freeze([Object.freeze(row(1)), Object.freeze(row(2, {
    open: 11, high: 11, low: 11, close: 11, volume: 0, turnover: 0, tradeCount: 0,
    status: '无成交，沿用前收盘',
  }))]);
  const before = JSON.stringify(input);
  const bars = buildBars(input);
  assert.deepEqual(bars, input.map((value, index) => ({ ...value, startIndex: index, endIndex: index })));
  assert.notEqual(bars, input);
  assert.notEqual(bars[0], input[0]);
  bars[0].close = 99;
  buildBars(input, 'week')[0].open = 99;
  assert.equal(JSON.stringify(input), before);
  for (const interval of ['day', 'week', 'month', 'year']) assert.deepEqual(buildBars([], interval), []);
  assert.throws(() => buildBars(input, 'quarter'), RangeError);
});

test('OHLC uses first open, last close, full extrema and actual volume/turnover/count sums', () => {
  const input = [row(1, { open: 10, high: 13, low: 9, close: 12, volume: 2, turnover: 24 }),
    row(2, { open: 12, high: 14, low: 11, close: 13, volume: 3, turnover: 39, tradeCount: 2 }),
    row(3, { open: 13, high: 13, low: 13, close: 13, volume: 0, turnover: 0, tradeCount: 0 })];
  const before = JSON.stringify(input);
  assert.deepEqual(buildBars(input, 'week'), [{
    open: 10, high: 14, low: 9, close: 13, volume: 5, turnover: 63, tradeCount: 3,
    status: '实际成交', dateLabel: '第1周', startIndex: 0, endIndex: 2,
    day: 1, year: 1, month: 1, dayOfMonth: 1,
  }]);
  assert.equal(JSON.stringify(input), before);
  const empty = buildBars([row(1, { volume: 0, turnover: 0, tradeCount: 0 })], 'week');
  assert.equal(empty[0].status, '无成交，沿用前收盘');
  assert.equal(empty[0].volume, 0);
});

test('weeks use simulation day rather than array offsets or the year boundary', () => {
  const input = [row(364, { year: 1, month: 12, dayOfMonth: 30 }),
    row(365, { year: 1, month: 12, dayOfMonth: 31 }),
    row(366, { year: 2, month: 1, dayOfMonth: 1 }),
    row(371, { year: 2, month: 1, dayOfMonth: 6 }),
    row(372, { year: 2, month: 1, dayOfMonth: 7 })];
  assert.deepEqual(buildBars(input, 'week').map((bar) => [bar.dateLabel, bar.startIndex, bar.endIndex]),
    [['第52周', 0, 0], ['第53周', 1, 3], ['第54周', 4, 4]]);
  const gap = buildBars([row(1), row(8), row(22)], 'week');
  assert.deepEqual(gap.map((bar) => bar.dateLabel), ['第1周', '第2周', '第4周']);
  assert.deepEqual(gap.map((bar) => bar.startIndex), [0, 1, 2]);
});

test('coefficient paths keep intraday and midnight changes across each selected period', () => {
  const daily = [
    row(365, { month: 12, dayOfMonth: 31, adjustmentCoefficient: '1.00 → 1.2 → 1' }),
    row(366, { year: 2, dayOfMonth: 1, volume: 0, tradeCount: 0, adjustmentCoefficient: '1.0 → 0' }),
    row(367, { year: 2, dayOfMonth: 2, adjustmentCoefficient: '0.00 → 0.000001' }),
  ];
  const paths = (interval) => buildBars(daily, interval).map((bar) => bar.coefficientPath);
  assert.deepEqual(paths('day'), [['1', '1.2', '1'], ['1', '0'], ['0', '0.000001']]);
  assert.deepEqual(paths('week'), [['1', '1.2', '1', '0', '0.000001']]);
  for (const interval of ['month', 'year']) {
    assert.deepEqual(paths(interval), [['1', '1.2', '1'], ['1', '0', '0.000001']]);
  }
  assert.equal(buildBars([row(1), row(2, { adjustmentCoefficient: '10' })], 'week')[0].coefficientPath, undefined);
});

test('new issue-window bars preserve the order of changes across a no-trade day', () => {
  const daily = [
    row(1, { issueWindowDays: '75→76→75' }),
    row(2, { issueWindowDays: '75→74', volume: 0, tradeCount: 0 }),
    row(3, { issueWindowDays: 74 }),
  ];
  const [bar] = buildBars(daily, 'week');
  assert.deepEqual(bar.issueWindowPath, ['75', '76', '75', '74']);
  assert.equal(bar.coefficientPath, undefined);
  assert.deepEqual(buildBars(daily, 'day')[2].issueWindowPath, ['74']);
});

test('months and years use the supplied simulation calendar and preserve inclusive source ranges', () => {
  const input = [row(365, { year: 1, month: 12, dayOfMonth: 31 }),
    row(366, { year: 2, month: 1, dayOfMonth: 1 }),
    row(396, { year: 2, month: 1, dayOfMonth: 31 }),
    row(397, { year: 2, month: 2, dayOfMonth: 1 }),
    row(731, { year: 3, month: 1, dayOfMonth: 1 })];
  assert.deepEqual(buildBars(input, 'month').map((bar) => [bar.dateLabel, bar.startIndex, bar.endIndex]),
    [['第1年 12月', 0, 0], ['第2年 01月', 1, 2], ['第2年 02月', 3, 3], ['第3年 01月', 4, 4]]);
  assert.deepEqual(buildBars(input, 'year').map((bar) => [bar.dateLabel, bar.startIndex, bar.endIndex]),
    [['第1年', 0, 0], ['第2年', 1, 3], ['第3年', 4, 4]]);
});

test('first bar has no invented previous close while its intrabar move remains available', () => {
  const bars = buildBars([row(1, { open: 10, close: 12 })]);
  assert.deepEqual(metrics(bars, 0), { previousClose: null, change: null, changePct: null,
    amplitudePct: null, intrabarPct: 20 });
  for (const index of [-1, 1, 0.5]) assert.deepEqual(metrics(bars, index), {
    previousClose: null, change: null, changePct: null, amplitudePct: null, intrabarPct: null,
  });
  assert.equal(metrics([], 0).previousClose, null);
});

test('annual returns use the first opening price and then each preceding year-end close', () => {
  const daily = [
    row(1, { open: 100, close: 110 }), row(365, { month: 12, dayOfMonth: 31, close: 120 }),
    row(366, { year: 2, dayOfMonth: 1, open: 140 }), row(730, { year: 2, month: 12, dayOfMonth: 31, close: 90 }),
    row(731, { year: 3, month: 1, dayOfMonth: 1, close: 90, volume: 0 }),
  ];
  assert.deepEqual(annualReturns(daily), [
    { year: 1, startIndex: 0, endIndex: 1, basePrice: 100, close: 120, changePct: 20, partial: false },
    { year: 2, startIndex: 2, endIndex: 3, basePrice: 120, close: 90, changePct: -25, partial: false },
    { year: 3, startIndex: 4, endIndex: 4, basePrice: 90, close: 90, changePct: 0, partial: true },
  ]);
  assert.deepEqual(annualReturns([]), []);
});

test('partial-year returns are unannualized and a zero baseline has no percentage', () => {
  const daily = [row(1, { open: 0, close: 9 }),
    row(365, { month: 12, dayOfMonth: 31, close: 10, status: '无成交；当日未结束' }),
    row(366, { year: 2, dayOfMonth: 1, close: 11 })];
  assert.deepEqual(annualReturns(daily).map((bar) => [bar.changePct, bar.partial]), [[null, true], [10, true]]);
});

test('gap changes compare with preceding close, independently from the candle body', () => {
  const bars = buildBars([row(1, { close: 100 }), row(8, { open: 120, high: 125, low: 108, close: 110 })]);
  const value = metrics(bars, 1);
  assert.equal(value.previousClose, 100);
  assert.equal(value.change, 10);
  assert.equal(value.changePct, 10);
  assert.equal(value.amplitudePct, 17);
  approximately(value.intrabarPct, -100 / 12);
  const monthly = buildBars([row(1, { close: 10 }), row(32, { month: 2, dayOfMonth: 1, close: 15 })], 'month');
  assert.equal(metrics(monthly, 1).changePct, 50);
});

test('zero or invalid previous close never falls back to the current open', () => {
  for (const previous of [0, -1, NaN, Infinity, undefined, null, '10']) {
    const result = metrics([row(1, { close: previous }), row(2, { open: 10, close: 11 })], 1);
    assert.deepEqual(result, { previousClose: null, change: null, changePct: null, amplitudePct: null, intrabarPct: 10 });
  }
  assert.equal(metrics([row(1), row(2, { open: 0 })], 1).intrabarPct, null);
  assert.equal(metrics([row(1), row(2, { high: NaN })], 1).amplitudePct, null);
  assert.equal(metrics([row(1), row(2, { close: NaN })], 1).changePct, null);
});

test('relative percent returns null for an unusable base rather than Infinity or NaN', () => {
  assert.equal(percentFrom(10, 8), 25);
  assert.equal(percentFrom(0, 8), -100);
  assert.equal(percentFrom(8, 8), 0);
  for (const base of [0, -1, null, undefined, NaN, Infinity, '1']) assert.equal(percentFrom(8, base), null);
  for (const value of [null, undefined, NaN, Infinity, '8']) assert.equal(percentFrom(value, 8), null);
  assert.equal(percentFrom(Number.MAX_VALUE, Number.MIN_VALUE), null);
});

test('price bounds include visible extrema with 8% padding, using inclusive indices', () => {
  const bars = [row(1, { low: 1, high: 1000 }), row(2, { low: 10, high: 20 }), row(3, { low: 12, high: 18 })];
  assert.deepEqual(priceBounds(bars, 1, 2), { min: 9.2, max: 20.8 });
  assert.deepEqual(priceBounds(bars, 1, 1), { min: 9.2, max: 20.8 });
  const nearZero = priceBounds([row(1, { low: 0.01, high: 1.01 })]);
  assert.equal(nearZero.min, 0);
  approximately(nearZero.max, 1.09);
});

test('single flat candles, tiny prices and empty views have readable nonnegative bounds', () => {
  assert.deepEqual(priceBounds([row(1, { low: 10, high: 10 })]), { min: 9.2, max: 10.8 });
  assert.deepEqual(priceBounds([row(1, { low: 0, high: 0 })]), { min: 0, max: 1 });
  for (const bars of [[], [row(1, { low: NaN, high: Infinity })]]) {
    assert.deepEqual(priceBounds(bars), { min: 0, max: 1 });
  }
  const tiny = priceBounds([row(1, { low: 1e-8, high: 1e-8 })]);
  assert.ok(tiny.min >= 0 && tiny.min < 1e-8 && tiny.max > 1e-8);
  assert.deepEqual(priceBounds([row(1)], 1, 0), { min: 0, max: 1 });
});

test('full checked-in history conserves quantities, turnover and trades at every interval', () => {
  const { daily } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'market.json'), 'utf8'));
  assert.ok(daily.length > 0);
  const before = JSON.stringify(daily);
  const total = (rows, field) => rows.reduce((sum, value) => sum + value[field], 0);
  for (const interval of ['day', 'week', 'month', 'year']) {
    const bars = buildBars(daily, interval);
    assert.equal(bars[0].startIndex, 0);
    assert.equal(bars.at(-1).endIndex, daily.length - 1);
    assert.equal(bars[0].open, daily[0].open);
    assert.equal(bars.at(-1).close, daily.at(-1).close);
    assert.equal(bars.reduce((count, bar) => count + bar.endIndex - bar.startIndex + 1, 0), daily.length);
    for (const field of ['volume', 'turnover']) approximately(total(bars, field), total(daily, field));
    assert.equal(total(bars, 'tradeCount'), total(daily, 'tradeCount'));
    bars.forEach((bar, index) => {
      if (index) assert.equal(bar.startIndex, bars[index - 1].endIndex + 1);
      assert.ok(bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close));
    });
  }
  assert.equal(JSON.stringify(daily), before);
});
