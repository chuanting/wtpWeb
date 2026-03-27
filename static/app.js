/* ══════════════════════════════════════════════
   济南市 4G/5G 流量可视化 — 主应用逻辑
══════════════════════════════════════════════ */

'use strict';

/* ── 状态 ──────────────────────────────────────── */
const state = {
  net:        '5g',      // '4g' | '5g'
  dir:        'down',    // 'down' | 'up'
  timeIdx:    0,
  playing:    false,
  speed:      1,
  streetId:   null,
  streetName: null,
  mapData:    null,
  meta:       null,
  geoData:    null,
  trainSSE:   null,
  trainStart: 0,
  elapsedTimer: null,
};

/* ── DOM 引用 ─────────────────────────────────── */
const $ = id => document.getElementById(id);
let mapChart   = null;
let seriesChart = null;
let predChart   = null;
let particles   = null;

/* ══════════════════════════════════════════════
   启动
══════════════════════════════════════════════ */
async function init() {
  showLoading(true);
  let step = '初始化';
  try {
    step = '检查 ECharts';
    if (typeof echarts === 'undefined') throw new Error('ECharts 未加载，请检查 /static/lib/echarts.min.js 是否存在');

    step = '加载 meta.json';
    const meta = await fetchJSON('/static/data/meta.json');

    step = '加载 map_data.json';
    const mapData = await fetchJSON('/static/data/map_data.json');

    step = '加载 geo.json';
    const geoData = await fetchJSON('/static/data/geo.json');

    state.mapData = mapData;
    state.meta    = meta;
    state.geoData = geoData;

    step = '注册地图';
    echarts.registerMap('jinan', geoData);

    step = '初始化图表';
    initMapChart();

    // 设置时间轴
    const slider = $('timeSlider');
    slider.max = mapData.times.length - 1;
    slider.value = 0;

    step = '渲染地图';
    renderMapFrame(0);

    // 绑定控件
    bindControls();

    showLoading(false);
  } catch (e) {
    console.error('初始化失败:', e);
    showLoading(false);
    const mask = document.getElementById('loadingMask') || (() => {
      const m = document.createElement('div');
      m.id = 'loadingMask';
      document.body.appendChild(m);
      return m;
    })();
    mask.style.opacity = '1';
    mask.innerHTML = `
      <div style="font-size:36px;margin-bottom:16px">⚠️</div>
      <div style="color:#ef4444;font-size:15px;font-weight:600;margin-bottom:8px">加载失败（步骤：${escHtml(step)}）</div>
      <div style="color:#4a6a8a;font-size:11px;font-family:monospace;background:#0d1526;padding:8px 14px;border-radius:4px;margin-bottom:12px;max-width:500px;word-break:break-all">${escHtml(String(e))}</div>
      <div style="color:#94a3b8;font-size:12px;max-width:400px;text-align:center;line-height:2">
        请确认：<br/>
        1. 通过 <code style="color:#00ff88;background:#0d1526;padding:1px 6px;border-radius:3px">http://localhost:8765</code> 访问，而非直接打开 HTML 文件<br/>
        2. 已在项目目录运行 <code style="color:#00d4ff;background:#0d1526;padding:1px 6px;border-radius:3px">python preprocess.py</code><br/>
        3. 已启动后端 <code style="color:#00d4ff;background:#0d1526;padding:1px 6px;border-radius:3px">python server.py</code>
      </div>
      <button onclick="location.reload()" style="margin-top:20px;padding:8px 24px;background:#0891b2;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">重新加载</button>
    `;
  }
}

/* ── 工具函数 ───────────────────────────────── */
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function showLoading(show) {
  let mask = $('loadingMask');
  if (!mask && show) {
    mask = document.createElement('div');
    mask.id = 'loadingMask';
    mask.innerHTML = `
      <div class="loading-logo">◈</div>
      <div class="loading-text">LOADING DATA ...</div>
      <div class="loading-bar-wrap"><div class="loading-bar"></div></div>`;
    document.body.appendChild(mask);
  } else if (mask && !show) {
    mask.style.transition = 'opacity 0.4s';
    mask.style.opacity = '0';
    setTimeout(() => mask.remove(), 400);
  }
}

/* ══════════════════════════════════════════════
   地图图表
══════════════════════════════════════════════ */
function initMapChart() {
  mapChart = echarts.init($('mapChart'), null, { renderer: 'canvas' });

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      className: 'echarts-tooltip',
      formatter(params) {
        if (!params.data) return '';
        const { name, value, id } = params.data;
        const district = state.meta[id]?.district || '';
        const v = value != null ? `${value.toFixed(1)} MB` : '无数据';
        return `
          <div style="font-size:13px;font-weight:600;margin-bottom:4px;color:#00d4ff">${name}</div>
          <div style="font-size:11px;color:#94a3b8;margin-bottom:6px">${district}</div>
          <div style="display:flex;justify-content:space-between;gap:20px">
            <span style="color:#94a3b8">${state.net.toUpperCase()} ${state.dir === 'down' ? '↓ 下行' : '↑ 上行'}</span>
            <span style="color:#fff;font-weight:600">${v}</span>
          </div>
        `;
      },
    },
    visualMap: {
      min: 0,
      max: 500,
      show: false,
      inRange: {
        color: ['#0c3547', '#0e7490', '#0891b2', '#f59e0b', '#ef4444'],
      },
    },
    geo: {
      map: 'jinan',
      roam: true,
      zoom: 1.05,
      center: [117.12, 36.65],
      emphasis: {
        label: { show: false },
        itemStyle: {
          areaColor: 'rgba(0, 212, 255, 0.25)',
          borderColor: '#00d4ff',
          borderWidth: 2,
        },
      },
      select: {
        label: { show: false },
        itemStyle: {
          areaColor: 'rgba(0, 212, 255, 0.35)',
          borderColor: '#00d4ff',
          borderWidth: 2,
        },
      },
      itemStyle: {
        areaColor: '#0d1a2e',
        borderColor: '#1e3a5f',
        borderWidth: 0.8,
      },
      label: { show: false },
    },
    series: [{
      name: 'traffic',
      type: 'map',
      map: 'jinan',
      geoIndex: 0,
      selectedMode: 'single',
      emphasis: { label: { show: false } },
      select:    { label: { show: false } },
      data: [],
    }],
  };

  mapChart.setOption(option);

  mapChart.on('click', params => {
    if (params.componentType === 'series' && params.seriesName === 'traffic') {
      const id   = params.data?.id;
      const name = params.data?.name;
      if (id) selectStreet(id, name);
    }
  });

  window.addEventListener('resize', () => mapChart.resize());
}

function renderMapFrame(timeIdx) {
  const md = state.mapData;
  if (!md) return;

  const key = `${state.net}_${state.dir}`;
  const streets = md[`streets_${state.net}`];
  const row = md[key][timeIdx];

  // 构建数据数组，name 用街道 Chinese 名，同时存 id 供 tooltip 用
  const data = streets.map((id, i) => ({
    id,
    name:  state.meta[id]?.name || id,
    value: row[i],
  }));

  // 动态计算最大值（第 95 百分位，避免极端值）
  const vals = row.filter(v => v > 0).sort((a, b) => a - b);
  const max95 = vals[Math.floor(vals.length * 0.95)] || 500;

  mapChart.setOption({
    visualMap: { max: max95 },
    series: [{ data }],
  });

  // 更新图例
  $('legendMax').textContent = `${max95.toFixed(0)}`;

  // 更新时间显示
  $('currentTimeBadge').textContent = md.times[timeIdx];
  $('mapSubtitle').textContent =
    `${state.net.toUpperCase()} ${state.dir === 'down' ? '↓ 下行' : '↑ 上行'} · ${md.times[timeIdx]}`;

  // 更新滑块进度
  const pct = (timeIdx / (md.times.length - 1)) * 100;
  $('timeSlider').value = timeIdx;
}

/* ══════════════════════════════════════════════
   控件绑定
══════════════════════════════════════════════ */
function bindControls() {
  // 网络切换
  $('netGroup').querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      $('netGroup').querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.net = btn.dataset.value;
      renderMapFrame(state.timeIdx);
      if (state.streetId) loadStreetSeries(state.streetId, state.streetName);
    });
  });

  // 方向切换
  $('dirGroup').querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      $('dirGroup').querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.dir = btn.dataset.value;
      renderMapFrame(state.timeIdx);
      if (state.streetId) loadStreetSeries(state.streetId, state.streetName);
    });
  });

  // 时间滑块
  $('timeSlider').addEventListener('input', e => {
    state.timeIdx = +e.target.value;
    renderMapFrame(state.timeIdx);
  });

  // 播放/暂停
  $('btnPlay').addEventListener('click', togglePlay);

  // 速度
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.speed = +btn.dataset.speed;
      if (state.playing) {
        clearInterval(state._playTimer);
        startPlayTimer();
      }
    });
  });

  // 训练按钮
  $('btnTrain').addEventListener('click', startTraining);
  $('btnRetrain').addEventListener('click', resetTrainingPanel);
}

function togglePlay() {
  state.playing = !state.playing;
  $('btnPlay').textContent = state.playing ? '⏸' : '▶';
  if (state.playing) {
    startPlayTimer();
  } else {
    clearInterval(state._playTimer);
  }
}

function startPlayTimer() {
  state._playTimer = setInterval(() => {
    state.timeIdx = (state.timeIdx + 1) % state.mapData.times.length;
    renderMapFrame(state.timeIdx);
  }, Math.max(50, 300 / state.speed));
}

/* ══════════════════════════════════════════════
   街道选择 & 时序图
══════════════════════════════════════════════ */
function selectStreet(id, name) {
  state.streetId   = id;
  state.streetName = name;

  // 更新训练面板
  const m = state.meta[id] || {};
  $('trainInfoBox').innerHTML = `
    <strong>${name}</strong>（${m.district || ''}）<br/>
    街道代码：<strong>${id}</strong><br/>
    位置：${m.ext_path || ''}
  `;
  $('trainHint').style.display  = 'none';
  $('trainReady').style.display = 'block';
  $('trainResult').style.display = 'none';
  $('terminal').style.display    = 'none';
  $('trainBadge').className      = 'train-status-badge';
  $('trainBadge').textContent    = '待机';

  // 加载时序
  loadStreetSeries(id, name);
}

async function loadStreetSeries(id, name) {
  $('seriesHint').style.display  = 'none';
  $('seriesChart').style.display = 'block';
  $('seriesTitle').textContent   = `${name} · 流量时序`;

  if (!seriesChart) {
    seriesChart = echarts.init($('seriesChart'), null, { renderer: 'canvas' });
    window.addEventListener('resize', () => seriesChart && seriesChart.resize());
  }

  seriesChart.showLoading({
    text: '加载中...',
    color: '#00d4ff',
    textColor: '#94a3b8',
    maskColor: 'rgba(6,12,26,0.8)',
  });

  try {
    // 同时加载 4G + 5G 的上行/下行（最多4条）
    const urls = [
      `/api/street/${id}?net=5g&dir=down`,
      `/api/street/${id}?net=5g&dir=up`,
      `/api/street/${id}?net=4g&dir=down`,
      `/api/street/${id}?net=4g&dir=up`,
    ];
    const labels  = ['5G 下行', '5G 上行', '4G 下行', '4G 上行'];
    const colors  = ['#00d4ff', '#a855f7', '#ff8c35', '#00ff88'];
    const results = await Promise.allSettled(urls.map(u => fetchJSON(u)));

    const series = [];
    let times = [];

    results.forEach((res, i) => {
      if (res.status !== 'fulfilled' || res.value.error) return;
      const { times: t, values: v } = res.value;
      if (!times.length) times = t;
      series.push({
        name:   labels[i],
        type:   'line',
        data:   v,
        smooth: true,
        lineStyle: { color: colors[i], width: 1.5 },
        itemStyle: { color: colors[i] },
        symbol: 'none',
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: hexToRgba(colors[i], 0.25) },
              { offset: 1, color: 'rgba(0,0,0,0)' },
            ],
          },
          opacity: 0.4,
        },
      });
    });

    const legendData = series.map(s => ({ name: s.name, itemStyle: { color: s.itemStyle.color } }));

    seriesChart.hideLoading();
    seriesChart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        className: 'echarts-tooltip',
        axisPointer: { type: 'cross', lineStyle: { color: '#1e3a5f' } },
        formatter(params) {
          let html = `<div style="font-size:11px;color:#94a3b8;margin-bottom:4px">${params[0]?.axisValue}</div>`;
          params.forEach(p => {
            if (p.value == null) return;
            html += `<div style="display:flex;justify-content:space-between;gap:16px">
              <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:4px"></span>${p.seriesName}</span>
              <strong>${p.value.toFixed(1)} MB</strong>
            </div>`;
          });
          return html;
        },
      },
      legend: {
        data: legendData.map(l => l.name),
        top: 0, right: 4,
        textStyle: { color: '#94a3b8', fontSize: 10 },
        icon: 'circle',
        itemWidth: 8, itemHeight: 8,
      },
      grid: { top: 28, bottom: 28, left: 44, right: 12 },
      xAxis: {
        type: 'category',
        data: times,
        axisLabel: {
          color: '#4a6a8a', fontSize: 9,
          formatter: v => v.slice(5, 16),
          interval: Math.floor(times.length / 5),
        },
        axisLine: { lineStyle: { color: '#1e3a5f' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        name: 'MB',
        nameTextStyle: { color: '#4a6a8a', fontSize: 9 },
        axisLabel: {
          color: '#4a6a8a', fontSize: 9,
          formatter: v => v >= 1000 ? `${(v / 1000).toFixed(1)}G` : `${v}`,
        },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: '#1e3a5f', type: 'dashed' } },
      },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', height: 14, bottom: 0, handleSize: 8,
          borderColor: '#1e3a5f', fillerColor: 'rgba(8,145,178,0.15)',
          textStyle: { color: '#4a6a8a', fontSize: 9 } },
      ],
      series,
    }, { notMerge: true });

  } catch (e) {
    seriesChart.hideLoading();
    console.error('时序加载失败:', e);
  }
}

/* ══════════════════════════════════════════════
   训练面板
══════════════════════════════════════════════ */
function startTraining() {
  if (!state.streetId) return;

  // 切换面板
  $('trainReady').style.display  = 'none';
  $('trainResult').style.display = 'none';
  $('terminal').style.display    = 'flex';
  $('trainBadge').className      = 'train-status-badge running';
  $('trainBadge').textContent    = '训练中';

  // 更新终端标题
  const name = state.streetName || state.streetId;
  $('termTitle').textContent = `LIGHTGBM · ${name} · ${state.net.toUpperCase()}`;

  // 清空日志
  $('termLog').innerHTML = '';
  $('termProgressBar').style.width = '0%';
  $('termPct').textContent = '0%';
  $('termIter').textContent = 'Iter: 0 / 300';
  $('termRmse').textContent = 'RMSE: —';
  $('termEta').textContent  = 'ETA: —';
  $('termPhaseLabel').textContent = '初始化...';

  // 启动粒子
  startParticles();

  // 开始计时
  state.trainStart = Date.now();
  state.elapsedTimer = setInterval(updateElapsed, 1000);

  // 关闭旧的 SSE
  if (state.trainSSE) state.trainSSE.close();

  const url = `/api/train?id=${state.streetId}&net=${state.net}`;
  state.trainSSE = new EventSource(url);

  const metricsCollected = {};

  state.trainSSE.onmessage = e => {
    const msg = JSON.parse(e.data);
    handleTrainMessage(msg, metricsCollected);
  };

  state.trainSSE.onerror = () => {
    state.trainSSE.close();
    appendLog('连接断开', 'error', '');
    $('trainBadge').className   = 'train-status-badge error';
    $('trainBadge').textContent = '错误';
    stopElapsedTimer();
    stopParticles();
  };
}

function handleTrainMessage(msg, metricsCollected) {
  switch (msg.type) {
    case 'phase':
      $('termPhaseLabel').textContent = msg.msg;
      appendLog(msg.msg, 'phase', msg.time);
      break;

    case 'log':
      appendLog(msg.msg, msg.level || 'info', msg.time);
      break;

    case 'iter': {
      const { iter, total, pct, rmse, mae, elapsed, eta, direction } = msg;
      $('termProgressBar').style.width = `${pct}%`;
      $('termPct').textContent  = `${pct.toFixed(0)}%`;
      $('termIter').textContent = `Iter: ${iter} / ${total}`;
      $('termRmse').textContent = `RMSE: ${rmse.toFixed(2)}`;
      $('termEta').textContent  = `ETA: ${formatSec(eta)}`;
      const dirLabel = direction === 'down' ? '↓下行' : '↑上行';
      appendLog(
        `[${dirLabel}] Iter ${String(iter).padStart(3)} / ${total}  RMSE=${rmse.toFixed(4)}  MAE=${mae.toFixed(4)}  ETA=${formatSec(eta)}`,
        'iter', msg.time
      );
      break;
    }

    case 'metrics': {
      metricsCollected[msg.direction] = msg;
      appendLog(
        `✓ ${msg.label} 完成 | RMSE=${msg.rmse.toFixed(2)}MB  MAE=${msg.mae.toFixed(2)}MB  R²=${msg.r2.toFixed(3)}  MAPE=${msg.mape.toFixed(1)}%`,
        'success', msg.time
      );
      break;
    }

    case 'done': {
      state.trainSSE.close();
      stopElapsedTimer();

      // 满进度
      $('termProgressBar').style.width = '100%';
      $('termPct').textContent = '100%';
      $('termPhaseLabel').textContent = '训练完成！';
      $('termEta').textContent = 'ETA: 0s';
      appendLog('══ 全部训练完成 ══', 'success', msg.time);

      $('trainBadge').className   = 'train-status-badge done';
      $('trainBadge').textContent = '完成';

      setTimeout(() => {
        showTrainingResults(metricsCollected, msg.results);
        stopParticles();
      }, 800);
      break;
    }

    case 'error':
      appendLog(`错误: ${msg.msg}`, 'error', msg.time);
      $('trainBadge').className   = 'train-status-badge error';
      $('trainBadge').textContent = '错误';
      stopElapsedTimer();
      stopParticles();
      state.trainSSE.close();
      break;
  }
}

function appendLog(msg, level, ts) {
  const log = $('termLog');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `
    <span class="log-ts">[${ts || nowStr()}]</span>
    <span class="log-prompt">›</span>
    <span class="log-msg level-${level}">${escHtml(msg)}</span>
  `;
  log.appendChild(line);
  // 自动滚到底
  log.scrollTop = log.scrollHeight;

  // 最多保留 200 行
  while (log.children.length > 200) log.removeChild(log.firstChild);
}

function showTrainingResults(metricsCollected, predResults) {
  $('terminal').style.display    = 'none';
  $('trainResult').style.display = 'block';

  // 指标卡片
  const grid = $('metricsGrid');
  grid.innerHTML = '';
  const dirs = ['down', 'up'];
  const dirLabels = { down: '↓下行', up: '↑上行' };
  const metricDefs = [
    { key: 'rmse', label: 'RMSE', unit: 'MB' },
    { key: 'mae',  label: 'MAE',  unit: 'MB' },
    { key: 'r2',   label: 'R²',   unit: '' },
    { key: 'mape', label: 'MAPE', unit: '%' },
  ];

  dirs.forEach(d => {
    const m = metricsCollected[d];
    if (!m) return;
    const header = document.createElement('div');
    header.style.cssText = 'grid-column:1/-1;font-size:10px;color:var(--text-dim);padding:4px 0 2px;text-transform:uppercase;letter-spacing:1px';
    header.textContent = `${state.net.toUpperCase()} ${dirLabels[d]}`;
    grid.appendChild(header);

    metricDefs.forEach(({ key, label, unit }) => {
      const card = document.createElement('div');
      card.className = 'metric-card';
      const val = m[key];
      card.innerHTML = `
        <div class="metric-label">${label}</div>
        <div class="metric-value">${typeof val === 'number' ? val.toFixed(key === 'mape' ? 1 : 3) : '—'}</div>
        <div class="metric-sub">${unit}</div>
      `;
      grid.appendChild(card);
    });
  });

  // 预测对比图
  buildPredChart(predResults);
}

function buildPredChart(predResults) {
  if (!predChart) {
    predChart = echarts.init($('predChart'), null, { renderer: 'canvas' });
    window.addEventListener('resize', () => predChart && predChart.resize());
  }

  const series = [];
  const colorMap = { down: ['#ef4444', '#ff8c35'], up: ['#00d4ff', '#a855f7'] };
  let times = [];

  Object.entries(predResults || {}).forEach(([dir, data], i) => {
    if (!data) return;
    if (!times.length) times = data.times;
    const [cActual, cPred] = colorMap[dir] || ['#fff', '#888'];
    const label = dir === 'down' ? '下行' : '上行';

    series.push({
      name: `${label} 实际`,
      type: 'line',
      data: data.actual,
      lineStyle: { color: cActual, width: 1.5 },
      itemStyle: { color: cActual },
      symbol: 'none',
      smooth: false,
    });
    series.push({
      name: `${label} 预测`,
      type: 'line',
      data: data.pred,
      lineStyle: { color: cPred, width: 1.5, type: 'dashed' },
      itemStyle: { color: cPred },
      symbol: 'none',
      smooth: true,
    });
  });

  predChart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      className: 'echarts-tooltip',
      axisPointer: { type: 'cross', lineStyle: { color: '#1e3a5f' } },
    },
    legend: {
      top: 0, right: 4,
      textStyle: { color: '#94a3b8', fontSize: 9 },
      icon: 'circle', itemWidth: 7, itemHeight: 7,
    },
    grid: { top: 24, bottom: 4, left: 40, right: 10 },
    xAxis: {
      type: 'category',
      data: times,
      axisLabel: { color: '#4a6a8a', fontSize: 8, formatter: v => v.slice(0, 5), interval: Math.floor(times.length / 4) },
      axisLine: { lineStyle: { color: '#1e3a5f' } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#4a6a8a', fontSize: 8, formatter: v => `${v.toFixed(0)}` },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#1e3a5f', type: 'dashed' } },
    },
    series,
  }, { notMerge: true });
}

function resetTrainingPanel() {
  $('trainResult').style.display = 'none';
  $('terminal').style.display    = 'none';
  $('trainReady').style.display  = 'block';
  $('trainBadge').className      = 'train-status-badge';
  $('trainBadge').textContent    = '待机';
}

/* ── 计时器 ─────────────────────────────────── */
function updateElapsed() {
  const sec = Math.floor((Date.now() - state.trainStart) / 1000);
  $('termElapsed').textContent = formatSec(sec, true);
}

function stopElapsedTimer() {
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

function formatSec(sec, pad = false) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (pad) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s.toFixed(0)}s`;
}

/* ── 粒子效果 ────────────────────────────────── */
let _particleRAF = null;
let _particleCtx = null;

function startParticles() {
  const canvas = $('particleCanvas');
  if (!canvas) return;
  _particleCtx = canvas.getContext('2d');

  const resize = () => {
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  };
  resize();

  const N = 60;
  const pts = Array.from({ length: N }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.4,
    vy: -Math.random() * 0.6 - 0.2,
    r:  Math.random() * 1.5 + 0.3,
    a:  Math.random(),
  }));

  function draw() {
    const ctx = _particleCtx;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    pts.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.a -= 0.003;
      if (p.a <= 0 || p.y < 0) {
        p.x = Math.random() * canvas.width;
        p.y = canvas.height + 2;
        p.vy = -Math.random() * 0.6 - 0.2;
        p.a = Math.random();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0, 255, 136, ${p.a.toFixed(2)})`;
      ctx.fill();

      // 连线
      pts.forEach(q => {
        const dx = p.x - q.x, dy = p.y - q.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 60) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `rgba(0, 180, 90, ${(0.15 * (1 - dist / 60)).toFixed(3)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      });
    });

    _particleRAF = requestAnimationFrame(draw);
  }
  draw();
}

function stopParticles() {
  if (_particleRAF) {
    cancelAnimationFrame(_particleRAF);
    _particleRAF = null;
  }
  if (_particleCtx) {
    const c = $('particleCanvas');
    if (c) _particleCtx.clearRect(0, 0, c.width, c.height);
    _particleCtx = null;
  }
}

/* ── 工具 ────────────────────────────────────── */
function nowStr() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ══════════════════════════════════════════════
   启动
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
