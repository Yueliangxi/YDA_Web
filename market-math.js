/* Pure OHLCV helpers. Calendar fields are supplied by the workbook, not Date. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YDAMarketMath = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const intervals = new Set(['day', 'week', 'month', 'year']);
  const sumFields = ['volume', 'turnover', 'tradeCount'];
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  // Compensated sums avoid accumulating avoidable rounding drift over 30 years.
  // Inputs/outputs remain JavaScript numbers, as in data/market.json.
  function add(total, value) {
    const next = total.value + value;
    total.correction += Math.abs(total.value) >= Math.abs(value)
      ? (total.value - next) + value : (value - next) + total.value;
    total.value = next;
  }

  function bucket(row, interval) {
    if (interval === 'week') return Math.floor((row.day - 1) / 7);
    if (interval === 'month') return `${row.year}:${row.month}`;
    return row.year;
  }

  function label(row, interval) {
    if (interval === 'week') return `第${Math.floor((row.day - 1) / 7) + 1}周`;
    if (interval === 'month') return `第${row.year}年 ${String(row.month).padStart(2, '0')}月`;
    return `第${row.year}年`;
  }

  function addCoefficientPath(bar, daily) {
    const path = [];
    for (let index = bar.startIndex; index <= bar.endIndex; index++) {
      const raw = daily[index].adjustmentCoefficient;
      if (raw == null) return bar;
      for (const token of String(raw).split('→')) {
        const value = token.trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        if (value !== path[path.length - 1]) path.push(value);
      }
    }
    bar.coefficientPath = path;
    return bar;
  }

  /** Input is the validated, chronological daily array. Both indices are inclusive. */
  function buildBars(daily, interval = 'day') {
    if (!Array.isArray(daily)) throw new TypeError('daily must be an array');
    if (!intervals.has(interval)) throw new RangeError(`Unsupported interval: ${interval}`);
    if (interval === 'day') {
      return daily.map((row, index) => addCoefficientPath({ ...row, startIndex: index, endIndex: index }, daily));
    }
    const bars = [];
    let key, current, totals;
    function finish() {
      if (!current) return;
      for (const field of sumFields) current[field] = totals[field].value + totals[field].correction;
      current.status = current.volume > 0 ? '实际成交' : '无成交，沿用前收盘';
      bars.push(addCoefficientPath(current, daily));
    }
    daily.forEach((row, index) => {
      const nextKey = bucket(row, interval);
      if (!current || nextKey !== key) {
        finish();
        key = nextKey;
        current = {
          open: row.open, high: row.high, low: row.low, close: row.close,
          volume: 0, turnover: 0, tradeCount: 0, status: '', dateLabel: label(row, interval),
          startIndex: index, endIndex: index,
          day: row.day, year: row.year, month: row.month, dayOfMonth: row.dayOfMonth,
        };
        totals = Object.fromEntries(sumFields.map((field) => [field, { value: 0, correction: 0 }]));
      }
      current.high = Math.max(current.high, row.high);
      current.low = Math.min(current.low, row.low);
      current.close = row.close;
      current.endIndex = index;
      for (const field of sumFields) add(totals[field], row[field]);
    });
    finish();
    return bars;
  }

  /** Relative percent, not a ratio; a valid positive base is mandatory. */
  function percentFrom(value, base) {
    if (!finite(value) || !finite(base) || base <= 0) return null;
    const result = ((value - base) / base) * 100;
    return Number.isFinite(result) ? result : null;
  }

  /** Change/amplitude use the preceding bar, even when it is outside the viewport. */
  function metrics(bars, index) {
    const result = { previousClose: null, change: null, changePct: null, amplitudePct: null, intrabarPct: null };
    if (!Number.isInteger(index) || index < 0 || index >= bars.length) return result;
    const current = bars[index];
    result.intrabarPct = percentFrom(current.close, current.open);
    const previous = index > 0 ? bars[index - 1].close : null;
    if (!finite(previous) || previous <= 0) return result;
    result.previousClose = previous;
    if (finite(current.close)) {
      const change = current.close - previous;
      result.change = Number.isFinite(change) ? change : null;
      result.changePct = percentFrom(current.close, previous);
    }
    if (finite(current.high) && finite(current.low) && current.high >= current.low) {
      const amplitude = ((current.high - current.low) / previous) * 100;
      result.amplitudePct = Number.isFinite(amplitude) ? amplitude : null;
    }
    return result;
  }

  /** Inclusive viewport indices; no zero baseline unless the data approaches zero. */
  function priceBounds(bars, start = 0, end = bars.length - 1) {
    let minimum = Infinity, maximum = -Infinity;
    if (!finite(start) || !finite(end)) return { min: 0, max: 1 };
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(bars.length - 1, Math.floor(end));
    for (let index = first; index <= last; index += 1) {
      const row = bars[index];
      if (finite(row.low) && row.low >= 0) minimum = Math.min(minimum, row.low);
      if (finite(row.high) && row.high >= 0) maximum = Math.max(maximum, row.high);
    }
    if (!finite(minimum) || !finite(maximum) || maximum < minimum) return { min: 0, max: 1 };
    if (minimum === 0 && maximum === 0) return { min: 0, max: 1 };
    const padding = Math.max(Number.MIN_VALUE, (maximum > minimum ? maximum - minimum : maximum) * 0.08);
    return { min: Math.max(0, minimum - padding), max: Math.min(Number.MAX_VALUE, maximum + padding) };
  }

  return Object.freeze({ buildBars, metrics, percentFrom, priceBounds });
});
