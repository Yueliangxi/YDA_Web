/* YDA market viewer. Data is regenerated from the workbook by scripts/build_data.py. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const colors = { price: '#245b4b', issued: '#d9bb70', traded: '#688fbd', up: '#218064', down: '#c76152', flat: '#98a29a', grid: '#edf0e8', label: '#8b9884' };
  const number = (value, decimals = 2) => Number(value).toLocaleString('en-US', { maximumFractionDigits: decimals });
  const price = (value) => value == null ? '—' : Number(value).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 8 });
  const math = window.YDAMarketMath;
  const signed = (value, decimals = 4) => value == null ? '—' : `${value > 0 ? '+' : ''}${number(value, decimals)}`;
  const percent = (value) => value == null ? '—' : `${signed(value)}%`;
  const trend = (value) => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
  const intervalNames = { day: '日', week: '周', month: '月', year: '年' };
  const compact = (value) => Math.abs(value) >= 1e8 ? `${number(value / 1e8)} 亿` : Math.abs(value) >= 1e4 ? `${number(value / 1e4)} 万` : number(value);
  const axisNumber = (value) => Math.abs(value) >= 1e8 ? `${number(value / 1e8, 1)}亿` : Math.abs(value) >= 1e4 ? `${number(value / 1e4, 1)}万` : number(value, 0);
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tooltipRow = (label, value) => `<div><span>${label}</span><em>${value}</em></div>`;
  const state = { data: null, charts: {}, dailyRange: [0, 0], priceRange: [0, 0], selectedDay: 0, selectedPrice: 0, page: 0, bars: [], interval: 'day', scale: 'price' };
  const pageSize = 25;

  const tooltip = {
    trigger: 'axis', confine: true, backgroundColor: '#fffffff5', borderColor: '#e3e9dc', borderWidth: 1,
    padding: [12, 15], extraCssText: 'box-shadow:0 5px 25px #263e1812;border-radius:9px;',
    axisPointer: { type: 'line', lineStyle: { color: '#a4b598', type: 'dashed' } },
  };
  const axisStyle = {
    axisLine: { lineStyle: { color: '#dfe5d9' } }, axisTick: { show: false },
    axisLabel: { color: colors.label, fontSize: 10, hideOverlap: true },
    splitLine: { lineStyle: { color: colors.grid, type: 'dashed' } },
  };

  function zoomOptions(xAxisIndex) {
    return [
      { type: 'inside', xAxisIndex, start: 0, end: 100, minValueSpan: 1, filterMode: 'filter', zoomOnMouseWheel: true, moveOnMouseMove: true, preventDefaultMouseMove: false },
      { type: 'slider', xAxisIndex, start: 0, end: 100, minValueSpan: 1, bottom: 15, height: 22, left: 60, right: 28,
        borderColor: '#e6ecdf', backgroundColor: '#f6f8f2', fillerColor: '#b8cc9b24',
        handleStyle: { color: '#fff', borderColor: '#9fb48b' }, moveHandleSize: 5,
        moveHandleStyle: { color: '#c9d6bc' }, dataBackground: { lineStyle: { color: '#bbcbae' }, areaStyle: { color: '#e4ebdb' } },
        selectedDataBackground: { lineStyle: { color: '#95ae7d' }, areaStyle: { color: '#ccdbbc' } },
        textStyle: { color: '#718566', fontSize: 9 }, showDetail: false, brushSelect: false },
    ];
  }

  function setupSummary() {
    const { daily, prices } = state.data;
    const latest = daily.at(-1);
    const volume = daily.reduce((sum, d) => sum + d.volume, 0);
    const issued = prices.reduce((sum, d) => sum + d.issued, 0);
    $('data-coverage').textContent = `${daily[0].dateLabel} — ${latest.dateLabel} · 共 ${number(daily.length, 0)} 天`;
    $('latest-date').textContent = latest.dateLabel;
    $('latest-close').textContent = price(latest.close);
    const { change, changePct } = math.metrics(daily, daily.length - 1);
    $('latest-change').textContent = `${percent(changePct)} 较前一日${latest.volume === 0 ? ' · 当日无成交' : ''}`;
    $('latest-change').classList.toggle('positive', change > 0);
    $('latest-change').classList.toggle('negative', change < 0);
    $('total-volume').textContent = compact(volume);
    $('day-count').textContent = `${number(volume)} YDA · ${number(daily.length, 0)} 天`;
    $('total-issued').textContent = compact(issued);
    $('price-count').textContent = `${number(issued)} YDA · ${prices.length} 个价格档位`;
    if (state.data.meta?.issuanceDescription) $('issuance-basis').textContent = state.data.meta.issuanceDescription;
  }

  function renderPriceChart() {
    const prices = state.data.prices;
    const chart = state.charts.price = echarts.init($('price-chart'), null, { renderer: 'canvas' });
    chart.setOption({
      animation: false, textStyle: { fontFamily: 'sans-serif' },
      legend: { show: false, data: ['最高价发行', '最高成交量发行', '实际成交量'] },
      grid: { left: 60, right: 62, top: 40, bottom: 82 },
      tooltip: { ...tooltip, formatter(params) {
        const d = prices[params[0]?.dataIndex];
        if (!d) return '';
        return `<div class="chart-tooltip"><b>${price(d.price)} HK</b>${tooltipRow('最高价发行', `${number(d.priceHighIssued)} YDA`)}${tooltipRow('最高成交量发行', `${number(d.volumeHighIssued)} YDA`)}${tooltipRow('发行合计', `${number(d.issued)} YDA`)}${tooltipRow('实际成交量', `${number(d.volume)} YDA`)}</div>`;
      } },
      xAxis: { ...axisStyle, type: 'category', data: prices.map((d) => price(d.price)), name: '价格 / HK', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: colors.label, fontSize: 10 }, splitLine: { show: false } },
      yAxis: [
        { ...axisStyle, type: 'value', name: '发行量 / YDA', nameTextStyle: { color: colors.price, fontSize: 10, align: 'left' }, axisLine: { show: false }, axisLabel: { ...axisStyle.axisLabel, formatter: axisNumber } },
        { ...axisStyle, type: 'value', position: 'right', name: '成交量 / YDA', nameTextStyle: { color: colors.traded, fontSize: 10, align: 'right' }, splitLine: { show: false }, axisLine: { show: false }, axisLabel: { ...axisStyle.axisLabel, color: colors.traded, formatter: axisNumber } },
      ],
      dataZoom: zoomOptions([0]).map((option) => option.type === 'slider' ? { ...option, right: 62 } : option),
      series: [
        { name: '最高价发行', type: 'bar', stack: 'issued', data: prices.map((d) => d.priceHighIssued), itemStyle: { color: colors.price }, barMaxWidth: 35, emphasis: { focus: 'series' } },
        { name: '最高成交量发行', type: 'bar', stack: 'issued', data: prices.map((d) => d.volumeHighIssued), itemStyle: { color: colors.issued }, barMaxWidth: 35, emphasis: { focus: 'series' } },
        { name: '实际成交量', type: 'line', yAxisIndex: 1, data: prices.map((d) => d.volume), symbol: 'circle', symbolSize: 5, showSymbol: false, lineStyle: { width: 2, color: colors.traded }, itemStyle: { color: colors.traded }, z: 4 },
      ],
    });
    chart.on('click', (params) => { if (params.componentType === 'series') selectPrice(params.dataIndex); });
    chart.on('datazoom', () => syncRange('price'));
    $('price-select').innerHTML = prices.map((d, i) => `<option value="${i}">${price(d.price)} HK</option>`).join('');
    selectPrice(prices.reduce((best, d, i) => d.issued > prices[best].issued ? i : best, 0));
    syncRange('price');
  }

  function selectPrice(index, reveal = false) {
    const d = state.data.prices[index];
    if (!d) return;
    state.selectedPrice = index;
    $('price-select').value = index;
    [['price-issued-high', d.priceHighIssued], ['price-issued-volume', d.volumeHighIssued], ['price-issued-total', d.issued], ['price-traded', d.volume]].forEach(([id, value]) => {
      $(id).innerHTML = `${number(value)} <small>YDA</small>`;
      $(id).title = `${number(value, 8)} YDA`;
    });
    if (reveal) revealIndex('price', index);
  }

  function barDates(d) {
    const first = state.data.daily[d.startIndex], last = state.data.daily[d.endIndex];
    return d.startIndex === d.endIndex ? first.dateLabel : `${first.dateLabel} — ${last.dateLabel}`;
  }

  function renderDailyChart() {
    const chart = state.charts.daily = echarts.init($('daily-chart'), null, { renderer: 'canvas' });
    chart.on('datazoom', () => syncRange('daily'));
    chart.on('updateAxisPointer', (event) => {
      const axis = event.axesInfo?.find((info) => info.axisDim === 'x');
      if (axis && Number.isInteger(Number(axis.value))) selectDay(Number(axis.value));
    });
    chart.getZr().on('click', (event) => {
      const point = [event.offsetX, event.offsetY];
      for (const gridIndex of [0, 1]) {
        if (chart.containPixel({ gridIndex }, point)) {
          selectDay(Math.round(chart.convertFromPixel({ gridIndex }, point)[0]));
          break;
        }
      }
    });
    rebuildDailyChart();
  }

  function rebuildDailyChart() {
    const chart = state.charts.daily;
    const bars = state.bars = math.buildBars(state.data.daily, state.interval);
    const end = bars.length - 1;
    const start = Math.max(0, end - (window.matchMedia('(max-width: 640px)').matches ? 29 : 89));
    state.dailyRange = [start, end];
    const xAxis = { ...axisStyle, type: 'category', data: bars.map((d) => d.dateLabel), boundaryGap: true, splitLine: { show: false }, axisLabel: { ...axisStyle.axisLabel, fontSize: 11, formatter: (label) => label.replace('月', '/').replace('日', '') }, axisPointer: { show: true, snap: true, label: { show: true, backgroundColor: colors.price, fontSize: 11 } } };
    chart.setOption({
      animation: false, textStyle: { fontFamily: 'sans-serif' },
      grid: [{ left: 76, right: 24, top: 32, height: '59%' }, { left: 76, right: 24, top: '73%', bottom: 72 }],
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: '#81958a', type: 'dashed' } },
      // The quote panel stays above the plot on touch screens, without obscuring candles.
      tooltip: { trigger: 'axis', showContent: false, axisPointer: { type: 'cross', crossStyle: { color: '#81958a', type: 'dashed' } } },
      xAxis: [{ ...xAxis, gridIndex: 0, axisLabel: { show: false }, axisLine: { show: false } }, { ...xAxis, gridIndex: 1 }],
      yAxis: [
        { ...axisStyle, type: 'value', gridIndex: 0, scale: true, splitNumber: 5, axisLine: { show: false }, nameTextStyle: { color: '#657b6e', fontSize: 11, align: 'left' }, axisPointer: { label: { backgroundColor: colors.price, formatter: ({ value }) => state.scale === 'percent' ? percent(value) : price(value) } } },
        { ...axisStyle, type: 'value', gridIndex: 1, name: '成交量 / YDA', nameTextStyle: { color: '#657b6e', fontSize: 11, align: 'left' }, splitNumber: 2, min: 0, axisLine: { show: false }, axisLabel: { ...axisStyle.axisLabel, formatter: axisNumber }, axisPointer: { label: { formatter: ({ value }) => number(value) } } },
      ],
      dataZoom: zoomOptions([0, 1]).map((option) => ({ ...option, minValueSpan: 0, start: start / Math.max(1, end) * 100, end: 100, ...(option.type === 'slider' ? { left: 76, right: 24 } : {}) })),
      series: [
        { id: 'candles', name: `${intervalNames[state.interval]} K`, type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 22,
          data: bars.map((d) => [d.open, d.close, d.low, d.high]),
          itemStyle: { color: colors.up, color0: colors.down, borderColor: colors.up, borderColor0: colors.down, borderColorDoji: colors.flat, borderWidth: 1.5 }, emphasis: { itemStyle: { borderWidth: 2.5 } } },
        { id: 'volume', name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 22, data: bars.map((d) => ({ value: d.volume, itemStyle: { color: d.close > d.open ? colors.up : d.close < d.open ? colors.down : colors.flat, opacity: 0.65 } })) },
      ],
    }, true);
    const options = bars.map((d, i) => `<option value="${i}">${escape(d.dateLabel)}</option>`).join('');
    ['range-start', 'range-end', 'day-select'].forEach((id) => { $(id).innerHTML = options; });
    $('daily-title').textContent = `${intervalNames[state.interval]} K 行情`;
    $('prev-day').setAttribute('aria-label', '上一根 K 线');
    $('next-day').setAttribute('aria-label', '下一根 K 线');
    document.querySelectorAll('[data-interval]').forEach((button) => {
      const active = button.dataset.interval === state.interval;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    selectDay(end);
    syncRange('daily');
  }

  function updateDailyScale() {
    const [start, end] = state.dailyRange;
    const bars = state.bars, base = bars[start].close;
    const usePercent = state.scale === 'percent' && base > 0;
    const convert = (value) => usePercent ? math.percentFrom(value, base) : value;
    const bounds = math.priceBounds(bars, start, end);
    const last = bars[end];
    const axisDecimals = Math.min(8, Math.max(3, Math.ceil(-Math.log10(Math.max(bounds.max - bounds.min, 1e-8))) + 1));
    state.charts.daily.setOption({
      yAxis: [{ name: usePercent ? '区间涨跌 / %' : '价格 / HK', min: convert(bounds.min), max: convert(bounds.max), axisLabel: { ...axisStyle.axisLabel, fontSize: 11, formatter: (value) => usePercent ? `${number(value, 4)}%` : number(value, axisDecimals) } }, {}],
      series: [{ id: 'candles', data: bars.map((d) => [d.open, d.close, d.low, d.high].map(convert)), markLine: { silent: true, symbol: ['none', 'none'], lineStyle: { color: '#85998d', type: 'dashed', width: 1 }, label: { position: 'insideEndTop', formatter: `末收 ${usePercent ? percent(convert(last.close)) : price(last.close)}`, color: '#547060', fontSize: 10 }, data: [{ yAxis: convert(last.close) }] } }],
    });
    $('scale-basis').textContent = usePercent
      ? `0% 基准：${bars[start].dateLabel}收盘 ${price(base)} HK；缩放或平移后随区间起点变化。`
      : state.scale === 'percent' ? '区间起点收盘价为 0，无法计算百分比；当前显示 HK 价格。' : 'HK 价格轴随可见区间自动缩放。虚线为区间最后一根收盘价。';
    document.querySelectorAll('[data-daily-scale]').forEach((button) => {
      const active = button.dataset.dailyScale === state.scale;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function selectDay(index, reveal = false) {
    const d = state.bars[index];
    if (!d || (state.quoteBar === d && !reveal)) return;
    state.quoteBar = d;
    state.selectedDay = index;
    const m = math.metrics(state.bars, index);
    $('day-select').value = index;
    $('selected-day-number').textContent = barDates(d);
    $('quote-close').textContent = price(d.close);
    $('quote-close').className = trend(m.change);
    $('quote-change').textContent = `${signed(m.change, 8)} HK / ${percent(m.changePct)}`;
    $('quote-change').className = trend(m.change);
    $('quote-comparison').textContent = `较前一${intervalNames[state.interval]}收盘`;
    $('prev-day').disabled = index === 0;
    $('next-day').disabled = index === state.bars.length - 1;
    const values = [['开盘', price(d.open), 'HK'], ['最高', price(d.high), 'HK'], ['最低', price(d.low), 'HK'], ['前收', price(m.previousClose), 'HK'], ['涨跌幅', percent(m.changePct), '', trend(m.change)], ['振幅', m.amplitudePct == null ? '—' : `${number(m.amplitudePct, 4)}%`, ''], ['成交量', compact(d.volume), 'YDA'], ['成交额', compact(d.turnover), 'HK']];
    $('daily-values').innerHTML = values.map(([label, value, unit, cls]) => `<div><dt>${label}</dt><dd class="${cls || ''}">${value}<small>${unit}</small></dd></div>`).join('');
    $('daily-status').textContent = `${d.status || ''} · ${number(d.tradeCount, 0)} 笔`;
    if ($('data-table').open) {
      document.querySelectorAll('#table-body tr').forEach((row) => {
        const day = Number(row.dataset.dayIndex);
        row.classList.toggle('selected', day >= d.startIndex && day <= d.endIndex);
      });
    }
    if (reveal) {
      revealIndex('daily', index);
      state.charts.daily.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: index });
      if ($('data-table').open) renderTable();
    }
  }

  function rawDailyRange() {
    return [state.bars[state.dailyRange[0]].startIndex, state.bars[state.dailyRange[1]].endIndex];
  }

  function rangeFromChart(kind) {
    const zoom = state.charts[kind].getOption().dataZoom[0];
    const count = kind === 'price' ? state.data.prices.length : state.bars.length;
    return [Math.max(0, Math.round(zoom.startValue ?? zoom.start / 100 * (count - 1))), Math.min(count - 1, Math.round(zoom.endValue ?? zoom.end / 100 * (count - 1)))];
  }

  function syncRange(kind) {
    const range = rangeFromChart(kind);
    state[`${kind}Range`] = range;
    if (kind === 'price') {
      $('price-range').textContent = `${price(state.data.prices[range[0]].price)} – ${price(state.data.prices[range[1]].price)} HK · ${range[1] - range[0] + 1} 档`;
      return;
    }
    $('range-start').value = range[0];
    $('range-end').value = range[1];
    $('daily-range').textContent = `显示 ${number(range[1] - range[0] + 1, 0)} / ${number(state.bars.length, 0)} 根${intervalNames[state.interval]} K`;
    updateDailyScale();
    document.querySelectorAll('[data-period]').forEach((button) => {
      const count = button.dataset.period === 'all' ? state.bars.length : Number(button.dataset.period);
      const active = range[1] === state.bars.length - 1 && (button.dataset.period === 'all' ? range[0] === 0 : count < state.bars.length && range[0] === state.bars.length - count);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    state.page = 0;
    if (state.selectedDay < range[0] || state.selectedDay > range[1]) {
      selectDay(Math.max(range[0], Math.min(range[1], state.selectedDay)));
    }
    if ($('data-table').open) renderTable();
  }

  function setRange(kind, start, end) {
    state.charts[kind].dispatchAction({ type: 'dataZoom', startValue: start, endValue: end });
    syncRange(kind);
  }

  function revealIndex(kind, index) {
    const [start, end] = state[`${kind}Range`];
    if (index >= start && index <= end) return;
    const last = (kind === 'price' ? state.data.prices.length : state.bars.length) - 1;
    const width = end - start;
    const newStart = Math.max(0, Math.min(last - width, index - Math.floor(width / 2)));
    setRange(kind, newStart, Math.min(last, newStart + width));
  }

  function changeZoom(kind, action) {
    const last = (kind === 'price' ? state.data.prices.length : state.bars.length) - 1;
    if (action === 'reset') return setRange(kind, 0, last);
    const [start, end] = state[`${kind}Range`];
    const span = Math.min(last, Math.max(1, Math.round((end - start) * (action === 'in' ? 0.5 : 2))));
    const selected = kind === 'price' ? state.selectedPrice : state.selectedDay;
    const center = selected >= start && selected <= end ? selected : (start + end) / 2;
    const nextStart = Math.max(0, Math.min(last - span, Math.round(center - span / 2)));
    setRange(kind, nextStart, nextStart + span);
  }

  function renderTable() {
    const [start, end] = rawDailyRange();
    const totalPages = Math.ceil((end - start + 1) / pageSize);
    state.page = Math.max(0, Math.min(state.page, totalPages - 1));
    const offset = start + state.page * pageSize;
    const rows = state.data.daily.slice(offset, Math.min(end + 1, offset + pageSize));
    $('table-body').innerHTML = rows.map((d, i) => `<tr data-day-index="${offset + i}" class="${offset + i >= state.bars[state.selectedDay].startIndex && offset + i <= state.bars[state.selectedDay].endIndex ? 'selected' : ''}"><td><button class="table-date" type="button" aria-label="查看 ${escape(d.dateLabel)} 明细">${escape(d.dateLabel)}</button></td><td>${price(d.open)}</td><td>${price(d.high)}</td><td>${price(d.low)}</td><td>${price(d.close)}</td><td class="${trend(math.metrics(state.data.daily, offset + i).change)}">${percent(math.metrics(state.data.daily, offset + i).changePct)}</td><td>${number(d.volume, 8)}</td><td>${number(d.turnover, 8)}</td><td>${number(d.tradeCount, 0)}</td></tr>`).join('');
    $('table-count').textContent = `当前区间 ${number(end - start + 1, 0)} 天`;
    $('table-page').textContent = `${state.page + 1} / ${totalPages}`;
    $('table-prev').disabled = state.page === 0;
    $('table-next').disabled = state.page === totalPages - 1;
  }

  function downloadCsv() {
    const [start, end] = rawDailyRange();
    const csvCell = (value) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = [['模拟日期', '开盘价(HK)', '最高价(HK)', '最低价(HK)', '收盘价(HK)', '前收盘价(HK)', '涨跌额(HK)', '涨跌幅(%)', '振幅(%)', '成交量(YDA)', '成交额(HK)', '成交笔数', '状态'],
      ...state.data.daily.slice(start, end + 1).map((d, i) => { const m = math.metrics(state.data.daily, start + i); return [d.dateLabel, d.open, d.high, d.low, d.close, m.previousClose ?? '', m.change ?? '', m.changePct ?? '', m.amplitudePct ?? '', d.volume, d.turnover, d.tradeCount, d.status]; })];
    const url = URL.createObjectURL(new Blob(['\uFEFF', rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `YDA_第${start + 1}至${end + 1}天.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toggleExpand(id) {
    const card = $(id);
    const expanded = !card.classList.contains('expanded');
    document.querySelectorAll('.chart-card.expanded').forEach((other) => {
      other.classList.remove('expanded');
      other.removeAttribute('role');
      other.removeAttribute('aria-modal');
      const button = other.querySelector('[data-expand]');
      button.setAttribute('aria-expanded', 'false');
      button.textContent = '⤢';
      button.setAttribute('aria-label', other.id === 'daily' ? '展开每日 K 线图' : '展开价格发行图');
    });
    card.classList.toggle('expanded', expanded);
    document.body.classList.toggle('has-expanded', expanded);
    document.querySelectorAll('.site-header, .intro, .summary-grid, .chart-card, .data-table-section, footer').forEach((element) => {
      element.inert = expanded && element !== card;
    });
    const button = card.querySelector('[data-expand]');
    button.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      button.textContent = '×';
      button.setAttribute('aria-label', '退出展开');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
    }
    button.focus();
    Object.values(state.charts).forEach((chart) => chart.resize());
  }

  function bindControls() {
    document.querySelectorAll('[data-interval]').forEach((button) => button.addEventListener('click', () => {
      state.interval = button.dataset.interval;
      $('range-error').hidden = true;
      rebuildDailyChart();
    }));
    document.querySelectorAll('[data-daily-scale]').forEach((button) => button.addEventListener('click', () => { state.scale = button.dataset.dailyScale; updateDailyScale(); }));
    document.querySelectorAll('[data-price-scale]').forEach((button) => button.addEventListener('click', () => {
      const separate = button.dataset.priceScale === 'separate';
      state.charts.price.setOption({
        grid: { right: separate ? 62 : 28 },
        yAxis: [{ name: separate ? '发行量 / YDA' : '数量 / YDA' }, { show: separate }],
        dataZoom: [{}, { right: separate ? 62 : 28 }],
        series: [{ name: '实际成交量', yAxisIndex: separate ? 1 : 0 }],
      });
      document.querySelectorAll('[data-price-scale]').forEach((control) => {
        const active = control === button;
        control.classList.toggle('active', active);
        control.setAttribute('aria-pressed', String(active));
      });
      $('scale-description').textContent = separate ? '左轴看发行，右轴看成交' : '同一刻度，直接比较数量';
      $('price-axis-note').textContent = separate ? '两色柱读左轴，蓝线读右轴。左右刻度不同；切换统一刻度可比较实际数量大小。' : '两色柱为发行量，蓝线为实际成交量，共用 YDA 数量轴。点击图例可切换显示。';
    }));
    document.querySelectorAll('[data-chart]').forEach((button) => button.addEventListener('click', () => changeZoom(button.dataset.chart, button.dataset.action)));
    document.querySelectorAll('[data-expand]').forEach((button) => button.addEventListener('click', () => toggleExpand(button.dataset.expand)));
    document.addEventListener('keydown', (event) => {
      const expanded = document.querySelector('.expanded');
      if (!expanded) return;
      if (event.key === 'Escape') toggleExpand(expanded.id);
      if (event.key === 'Tab') {
        const controls = [...expanded.querySelectorAll('button:not(:disabled), select, [tabindex="0"]')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    document.querySelectorAll('[data-series]').forEach((button) => button.addEventListener('click', () => {
      state.charts.price.dispatchAction({ type: 'legendToggleSelect', name: button.dataset.series });
      const selected = state.charts.price.getOption().legend[0].selected[button.dataset.series] !== false;
      button.setAttribute('aria-pressed', String(selected));
    }));
    $('price-select').addEventListener('change', (event) => selectPrice(Number(event.target.value), true));
    $('day-select').addEventListener('change', (event) => selectDay(Number(event.target.value), true));
    $('prev-day').addEventListener('click', () => selectDay(state.selectedDay - 1, true));
    $('next-day').addEventListener('click', () => selectDay(state.selectedDay + 1, true));
    document.querySelectorAll('[data-period]').forEach((button) => button.addEventListener('click', () => {
      const count = button.dataset.period === 'all' ? state.bars.length : Number(button.dataset.period);
      setRange('daily', Math.max(0, state.bars.length - count), state.bars.length - 1);
      $('range-error').hidden = true;
    }));
    $('apply-range').addEventListener('click', () => {
      const start = Number($('range-start').value), end = Number($('range-end').value);
      if (start > end) { $('range-error').textContent = '起始日期应早于或等于结束日期，请调整后再查看。'; $('range-error').hidden = false; return; }
      $('range-error').hidden = true;
      // One-day ranges remain useful; minValueSpan is relaxed for an explicit day selection.
      state.charts.daily.setOption({ dataZoom: [{ minValueSpan: 0 }, { minValueSpan: 0 }] });
      setRange('daily', start, end);
    });
    $('data-table').addEventListener('toggle', () => { if ($('data-table').open) renderTable(); });
    $('table-prev').addEventListener('click', () => { state.page--; renderTable(); });
    $('table-next').addEventListener('click', () => { state.page++; renderTable(); });
    $('table-body').addEventListener('click', (event) => { const row = event.target.closest('[data-day-index]'); if (row) {
      const day = Number(row.dataset.dayIndex);
      if (state.interval !== 'day') { state.interval = 'day'; rebuildDailyChart(); }
      selectDay(day, true);
    } });
    $('download-csv').addEventListener('click', downloadCsv);
    const observer = new ResizeObserver(() => Object.values(state.charts).forEach((chart) => chart.resize()));
    observer.observe($('price-chart'));
    observer.observe($('daily-chart'));
  }

  async function init() {
    try {
      if (!math) throw new Error('行情计算模块未能加载，请刷新页面重试。');
      if (!window.echarts) throw new Error('图表库未能加载，请刷新页面重试。');
      const response = await fetch('./data/market.json');
      if (!response.ok) throw new Error(`行情数据读取失败（${response.status}）。`);
      state.data = await response.json();
      if (!state.data.prices?.length || !state.data.daily?.length) throw new Error('行情数据为空。');
      $('dashboard').hidden = false;
      setupSummary();
      renderPriceChart();
      renderDailyChart();
      bindControls();
    } catch (error) {
      $('dashboard').hidden = true;
      $('data-coverage').textContent = '行情暂时无法显示';
      $('load-error').hidden = false;
      $('load-error').textContent = `${error.message} 请确认网页通过 HTTP 服务打开，并检查网络后重试。`;
      console.error(error);
    }
  }

  init();
})();
