/* ══════════════════════════════════════════════
   济南市 4G/5G 流量可视化 — 主应用逻辑
   地图: MapLibre GL JS   图表: ECharts 5
══════════════════════════════════════════════ */

'use strict';

/* ── 状态 ──────────────────────────────────────── */
const state = {
  net:        '5g',
  dir:        'down',
  timeIdx:    0,
  playing:    false,
  speed:      1,
  mapMode:    'flat',   // 'flat' | '3d'
  streetId:   null,
  streetName: null,
  mapData:    null,
  meta:       null,
  geoData:    null,
  trainSSE:   null,
  trainStart: 0,
  elapsedTimer: null,
  _currentMax: 500,
  _playTimer:  null,
};

/* ── DOM 引用 ─────────────────────────────────── */
const $ = id => document.getElementById(id);
let mlMap         = null;   // MapLibre 实例
let mapLoaded     = false;
let hoveredFeatId = null;   // 当前 hover 的 feature id
let selectedFeatId = null;  // 当前选中的 feature id
let seriesChart   = null;
let predChart     = null;
let _animTimer    = null;   // 时序动画定时器
let _animData     = null;   // 时序原始数据 { times, rawSeries[] }

/* ── 主题配色表 ──────────────────────────────────── */
const THEME_COLORS = {
  ocean:    { series: ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24'] },
  business: { series: ['#feda6a', '#e8a030', '#5cbdb9', '#f47560'] },
  cyber:    { series: ['#67e8f9', '#00ff9f', '#ff79c6', '#ffff00'] },
  aurora:   { series: ['#d08ff7', '#51d0de', '#f472b6', '#34d399'] },
  mono:     { series: ['#e0e0e0', '#a8a8a8', '#c8c8c8', '#787878'] },
  emerald:  { series: ['#34d399', '#60a5fa', '#fbbf24', '#f472b6'] },
};

function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem('theme', name);
  const sel = document.getElementById('themeSelect');
  if (sel) sel.value = name;

  // 1. 更新地图色阶
  COLOR_STOPS = THEME_MAP_STOPS[name] || THEME_MAP_STOPS.ocean;
  if (mapLoaded) renderMapFrame(state.timeIdx);
  updateLegendGradient();

  // 2. 更新时序图系列颜色
  const colors = (THEME_COLORS[name] || THEME_COLORS.ocean).series;
  if (_animData?.rawSeries?.length) {
    _animData.rawSeries.forEach((s, i) => { if (colors[i]) s.color = colors[i]; });
    if (seriesChart) {
      stopSeriesAnimation();
      seriesChart.setOption({
        series: _animData.rawSeries.map(s => ({
          lineStyle: { color: s.color },
          itemStyle: { color: s.color },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: hexToRgba(s.color, 0.25) },
                { offset: 1, color: 'rgba(0,0,0,0)' },
              ],
            },
            opacity: 0.4,
          },
        })),
      });
      runSeriesAnimation();
    }
  }
}

function updateLegendGradient() {
  const el = document.getElementById('legendGradient');
  if (!el) return;
  const grad = COLOR_STOPS
    .map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(0)}%`)
    .join(', ');
  el.style.background = `linear-gradient(90deg, ${grad})`;
}

/* ── 各主题地图色阶 ──────────────────────────────── */
const THEME_MAP_STOPS = {
  ocean:    [
    [0,    [15,  31,  61]],   // 深海蓝
    [0.2,  [30,  64, 175]],   // 钴蓝
    [0.5,  [14, 165, 233]],   // 天蓝
    [0.78, [186, 230, 253]],  // 冰蓝
    [1.0,  [255, 255, 255]],  // 纯白
  ],
  business: [
    [0,    [20,  18,  12]],   // 炭黑
    [0.2,  [90,  60,   8]],   // 深金棕
    [0.5,  [212, 168,  50]],  // 暗金
    [0.78, [254, 218, 106]],  // 亮金
    [1.0,  [255, 248, 220]],  // 奶白
  ],
  cyber:    [
    [0,    [2,    8,  20]],   // 近黑
    [0.2,  [0,   60,  90]],   // 深青
    [0.5,  [0,  180, 220]],   // 电青
    [0.78, [103, 232, 249]],  // 亮青
    [1.0,  [220, 255, 255]],  // 冰白
  ],
  aurora:   [
    [0,    [7,    3,  26]],   // 深空紫
    [0.2,  [50,  10, 120]],   // 暗紫
    [0.5,  [147,  51, 234]],  // 紫罗兰
    [0.78, [208, 143, 247]],  // 薰衣草
    [1.0,  [255, 240, 255]],  // 淡紫白
  ],
  mono:     [
    [0,    [12,  12,  12]],   // 黑
    [0.2,  [50,  50,  50]],   // 深灰
    [0.5,  [120, 120, 120]],  // 中灰
    [0.78, [200, 200, 200]],  // 浅灰
    [1.0,  [255, 255, 255]],  // 白
  ],
  emerald:  [
    [0,    [2,   15,   7]],   // 深林
    [0.2,  [6,   70,  40]],   // 暗绿
    [0.5,  [16,  185, 129]],  // 翡翠
    [0.78, [167, 243, 208]],  // 薄荷
    [1.0,  [240, 255, 248]],  // 白绿
  ],
};

/* ── 当前色阶（可被主题替换）─────────────────────── */
let COLOR_STOPS = THEME_MAP_STOPS.ocean;

function valueToRgb(val, max) {
  const t = Math.min(val / (max || 1), 1);
  let lo = COLOR_STOPS[0], hi = COLOR_STOPS[COLOR_STOPS.length - 1];
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    if (t >= COLOR_STOPS[i][0] && t <= COLOR_STOPS[i + 1][0]) {
      lo = COLOR_STOPS[i]; hi = COLOR_STOPS[i + 1]; break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const r = (t - lo[0]) / span;
  return lo[1].map((v, i) => Math.round(v + r * (hi[1][i] - v)));
}

function valueToColor(val, max) {
  const [r, g, b] = valueToRgb(val, max);
  return `rgb(${r},${g},${b})`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ══════════════════════════════════════════════
   启动
══════════════════════════════════════════════ */
async function init() {
  showLoading(true);
  let step = '初始化';
  try {
    step = '检查 MapLibre & ECharts';
    if (typeof maplibregl === 'undefined') throw new Error('MapLibre GL JS 未加载');
    if (typeof echarts    === 'undefined') throw new Error('ECharts 未加载');

    step = '加载 meta.json';
    const meta = await fetchJSON('/static/data/meta.json');

    step = '加载 map_data.json';
    const mapData = await fetchJSON('/static/data/map_data.json');

    step = '加载 geo.json';
    const geoData = await fetchJSON('/static/data/geo.json');

    state.meta    = meta;
    state.mapData = mapData;
    state.geoData = geoData;

    step = '初始化地图';
    initMap();

    const slider = $('timeSlider');
    slider.max   = mapData.times.length - 1;
    slider.value = 0;

    bindControls();
    initResizer();
    initMobileTabs();

    // 恢复已保存的主题
    const savedTheme = localStorage.getItem('theme') || 'ocean';
    applyTheme(savedTheme);
    $('themeSelect')?.addEventListener('change', e => applyTheme(e.target.value));

    showLoading(false);
  } catch (e) {
    console.error('初始化失败:', e);
    showLoading(false);
    let mask = $('loadingMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'loadingMask';
      document.body.appendChild(mask);
    }
    mask.style.cssText = 'position:fixed;inset:0;background:var(--bg-base);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:16px';
    mask.innerHTML = `
      <div style="font-size:36px">⚠️</div>
      <div style="color:#ef4444;font-size:15px;font-weight:600">加载失败（步骤：${escHtml(step)}）</div>
      <div style="color:#4a6a8a;font-size:11px;font-family:monospace;background:#0d1526;padding:8px 14px;border-radius:4px;max-width:500px;word-break:break-all">${escHtml(String(e))}</div>
      <div style="color:#94a3b8;font-size:12px;text-align:center;line-height:2">
        请通过 <code style="color:#00ff88">http://localhost:8765</code> 访问，勿直接打开 HTML 文件
      </div>
      <button onclick="location.reload()" style="padding:8px 24px;background:#0891b2;color:#fff;border:none;border-radius:6px;cursor:pointer">重新加载</button>
    `;
  }
}

/* ── 工具 ────────────────────────────────────── */
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
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

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nowStr() {
  return new Date().toTimeString().slice(0, 8);
}

function formatSec(sec, pad = false) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  if (pad) return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return m > 0 ? `${m}m${String(s).padStart(2,'0')}s` : `${Math.round(sec)}s`;
}

/* ══════════════════════════════════════════════
   MapLibre 地图
══════════════════════════════════════════════ */
function buildColoredGeoJSON(timeIdx) {
  const key     = `${state.net}_${state.dir}`;
  const streets = state.mapData[`streets_${state.net}`];
  const row     = state.mapData[key][timeIdx];

  const valueMap = {};
  streets.forEach((id, i) => { valueMap[id] = row[i]; });

  const sorted = row.filter(v => v > 0).sort((a, b) => a - b);
  const max95  = sorted[Math.floor(sorted.length * 0.95)] || 500;
  state._currentMax = max95;

  return {
    type: 'FeatureCollection',
    features: state.geoData.features.map(f => {
      const val = valueMap[f.properties.id] || 0;
      return {
        ...f,
        properties: {
          ...f.properties,
          fillColor: valueToColor(val, max95),
          value:     val,
          // 3D 高度：最高流量对应 6000m，视觉冲击力强
          extHeight: val > 0 ? Math.round((val / max95) * 6000) : 0,
        },
      };
    }),
  };
}

function initMap() {
  // Carto Dark Matter 底图（国内无法加载时回落到纯暗底）
  const cartoDark = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
  const plainDark = {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#060c1a' } }],
  };

  mlMap = new maplibregl.Map({
    container:        'mapChart',
    style:            cartoDark,
    center:           [117.12, 36.65],
    zoom:             9.8,
    antialias:        true,
    attributionControl: false,
    pitchWithRotate:  true,
    dragRotate:       false,   // 默认禁止旋转，3D 模式时开启
  });

  mlMap.addControl(
    new maplibregl.NavigationControl({ showCompass: false }), 'top-right'
  );
  mlMap.addControl(
    new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left'
  );


  // 底图加载失败时回落到纯暗色
  mlMap.on('error', e => {
    if (e.error?.status === 0 || String(e.error).includes('style')) {
      mlMap.setStyle(plainDark);
    }
  });

  // style.load 在初始加载和每次 setStyle 后都会触发
  // 确保 source/layer 始终存在
  mlMap.on('style.load', () => {
    mapLoaded = true;
    addMapLayers();
    renderMapFrame(state.timeIdx);
  });

  window.addEventListener('resize', () => mlMap && mlMap.resize());
}

function addMapLayers() {
  const geo = buildColoredGeoJSON(state.timeIdx);

  mlMap.addSource('streets', {
    type:       'geojson',
    data:       geo,
    generateId: true,
  });

  // ① 填充层 —— 主视觉
  mlMap.addLayer({
    id:     'streets-fill',
    type:   'fill',
    source: 'streets',
    paint: {
      'fill-color':   ['get', 'fillColor'],
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0.95,
        ['boolean', ['feature-state', 'hover'],    false], 0.85,
        0.72,
      ],
    },
  });

  // ② 选中光晕 —— 宽线 + 模糊（蓝色）
  mlMap.addLayer({
    id:     'streets-glow',
    type:   'line',
    source: 'streets',
    paint: {
      'line-color':   '#3b82f6',
      'line-width':   ['case', ['boolean', ['feature-state', 'selected'], false], 14, 0],
      'line-opacity': 0.28,
      'line-blur':    10,
    },
  });

  // ③ 边框线（白色 / 选中蓝色）
  mlMap.addLayer({
    id:     'streets-outline',
    type:   'line',
    source: 'streets',
    paint: {
      'line-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#60a5fa',
        '#ffffff',
      ],
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 3.5,
        ['boolean', ['feature-state', 'hover'],    false], 2.0,
        1.0,
      ],
      'line-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 1.0,
        ['boolean', ['feature-state', 'hover'],    false], 0.75,
        0.35,
      ],
    },
  });

  // ④ 3D 柱状图层（默认隐藏）
  mlMap.addLayer({
    id:     'streets-3d',
    type:   'fill-extrusion',
    source: 'streets',
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color':   ['get', 'fillColor'],
      'fill-extrusion-height':  ['get', 'extHeight'],
      'fill-extrusion-base':    0,
      'fill-extrusion-opacity': 0.88,
    },
  });

  // style.load 重触发后，恢复当前模式的可见性
  if (state.mapMode === '3d') {
    ['streets-fill', 'streets-glow', 'streets-outline'].forEach(id =>
      mlMap.setLayoutProperty(id, 'visibility', 'none')
    );
    mlMap.setLayoutProperty('streets-3d', 'visibility', 'visible');
  }

  // 3D 模式下的 hover / click 事件
  mlMap.on('mousemove', 'streets-3d', e => {
    mlMap.getCanvas().style.cursor = 'pointer';
    const f = e.features?.[0];
    if (!f) return;
    if (hoveredFeatId !== null && hoveredFeatId !== f.id)
      mlMap.setFeatureState({ source: 'streets', id: hoveredFeatId }, { hover: false });
    hoveredFeatId = f.id;
    mlMap.setFeatureState({ source: 'streets', id: f.id }, { hover: true });
    showMapTooltip(e.originalEvent, f.properties);
  });
  mlMap.on('mouseleave', 'streets-3d', () => {
    mlMap.getCanvas().style.cursor = '';
    if (hoveredFeatId !== null) {
      mlMap.setFeatureState({ source: 'streets', id: hoveredFeatId }, { hover: false });
      hoveredFeatId = null;
    }
    hideMapTooltip();
  });
  mlMap.on('click', 'streets-3d', e => {
    const f = e.features?.[0];
    if (!f) return;
    if (selectedFeatId !== null)
      mlMap.setFeatureState({ source: 'streets', id: selectedFeatId }, { selected: false });
    selectedFeatId = f.id;
    mlMap.setFeatureState({ source: 'streets', id: f.id }, { selected: true });
    selectStreet(f.properties.id, f.properties.name);
  });

  // ── Hover（热力图层）──
  mlMap.on('mousemove', 'streets-fill', e => {
    mlMap.getCanvas().style.cursor = 'pointer';
    const f = e.features?.[0];
    if (!f) return;
    if (hoveredFeatId !== null && hoveredFeatId !== f.id) {
      mlMap.setFeatureState({ source: 'streets', id: hoveredFeatId }, { hover: false });
    }
    hoveredFeatId = f.id;
    mlMap.setFeatureState({ source: 'streets', id: f.id }, { hover: true });
    showMapTooltip(e.originalEvent, f.properties);
  });

  mlMap.on('mouseleave', 'streets-fill', () => {
    mlMap.getCanvas().style.cursor = '';
    if (hoveredFeatId !== null) {
      mlMap.setFeatureState({ source: 'streets', id: hoveredFeatId }, { hover: false });
      hoveredFeatId = null;
    }
    hideMapTooltip();
  });

  // ── 点击选中 ──
  mlMap.on('click', 'streets-fill', e => {
    const f = e.features?.[0];
    if (!f) return;
    if (selectedFeatId !== null) {
      mlMap.setFeatureState({ source: 'streets', id: selectedFeatId }, { selected: false });
    }
    selectedFeatId = f.id;
    mlMap.setFeatureState({ source: 'streets', id: f.id }, { selected: true });
    selectStreet(f.properties.id, f.properties.name);
  });
}

/* ══════════════════════════════════════════════
   3D 自动旋转
══════════════════════════════════════════════ */
let _rotRAF     = null;
let _rotActive  = false;
const ROT_SPEED = 0.05;   // 度/帧，约 3°/s，75秒转一圈

function startRotation() {
  if (_rotRAF) return;
  _rotActive = true;
  const step = () => {
    if (!_rotActive || !mlMap) return;
    if (!mlMap.isZooming()) {
      mlMap.setBearing((mlMap.getBearing() + ROT_SPEED) % 360);
    }
    _rotRAF = requestAnimationFrame(step);
  };
  _rotRAF = requestAnimationFrame(step);
  $('btnRotate')?.classList.add('active');
}

function stopRotation() {
  _rotActive = false;
  if (_rotRAF) { cancelAnimationFrame(_rotRAF); _rotRAF = null; }
  $('btnRotate')?.classList.remove('active');
}

function toggleRotation() {
  _rotActive ? stopRotation() : startRotation();
}

function toggleMapMode(mode) {
  if (!mapLoaded) return;
  state.mapMode = mode;
  const is3d = mode === '3d';

  const setVis = (id, vis) => {
    if (mlMap.getLayer(id)) mlMap.setLayoutProperty(id, 'visibility', vis);
  };

  ['streets-fill', 'streets-glow', 'streets-outline'].forEach(id =>
    setVis(id, is3d ? 'none' : 'visible')
  );
  setVis('streets-3d', is3d ? 'visible' : 'none');

  if (is3d) {
    mlMap.dragRotate.enable();
    mlMap.touchZoomRotate.enableRotation();
    mlMap.easeTo({ pitch: 55, bearing: -20, duration: 900 });
    $('btnRotate').style.display = '';
    // 进入 3D 后自动开始旋转
    setTimeout(startRotation, 950);
  } else {
    stopRotation();
    mlMap.dragRotate.disable();
    mlMap.touchZoomRotate.disableRotation();
    mlMap.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    $('btnRotate').style.display = 'none';
  }

  // 切换后强制刷新当前帧数据
  renderMapFrame(state.timeIdx);
}

function reapplyFeatureStates() {
  if (!mapLoaded) return;
  if (hoveredFeatId  !== null)
    mlMap.setFeatureState({ source: 'streets', id: hoveredFeatId  }, { hover: true });
  if (selectedFeatId !== null)
    mlMap.setFeatureState({ source: 'streets', id: selectedFeatId }, { selected: true });
}

function renderMapFrame(timeIdx) {
  state.timeIdx = timeIdx;

  if (mapLoaded && mlMap) {
    const source = mlMap.getSource('streets');
    if (!source) return;   // 样式切换瞬间 source 可能尚未就绪
    source.setData(buildColoredGeoJSON(timeIdx));
    requestAnimationFrame(reapplyFeatureStates);
    $('legendMax').textContent = `${state._currentMax.toFixed(0)}`;
  }

  const time = state.mapData.times[timeIdx];
  $('currentTimeBadge').textContent = time;
  $('mapSubtitle').textContent =
    `${state.net.toUpperCase()} ${state.dir === 'down' ? '↓ 下行' : '↑ 上行'} · ${time}`;
  $('timeSlider').value = timeIdx;
}

/* ── 地图 Tooltip ────────────────────────────── */
function showMapTooltip(event, props) {
  const tt = $('mapTooltip');
  if (!tt) return;
  const val      = props.value != null ? `${Number(props.value).toFixed(1)} MB` : '无数据';
  const district = state.meta?.[props.id]?.district || '';
  const dirLabel = state.dir === 'down' ? '↓ 下行' : '↑ 上行';
  tt.innerHTML = `
    <div class="tt-name">${escHtml(props.name)}</div>
    <div class="tt-district">${escHtml(district)}</div>
    <div class="tt-row">
      <span>${state.net.toUpperCase()} ${dirLabel}</span>
      <strong>${val}</strong>
    </div>`;
  tt.style.display = 'block';
  tt.style.left = `${event.clientX + 14}px`;
  tt.style.top  = `${event.clientY - 50}px`;
}

function hideMapTooltip() {
  const tt = $('mapTooltip');
  if (tt) tt.style.display = 'none';
}

/* ══════════════════════════════════════════════
   控件绑定
══════════════════════════════════════════════ */
function bindControls() {
  $('netGroup').querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      $('netGroup').querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.net = btn.dataset.value;
      renderMapFrame(state.timeIdx);
      if (state.streetId) loadStreetSeries(state.streetId, state.streetName);
    });
  });

  $('dirGroup').querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      $('dirGroup').querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.dir = btn.dataset.value;
      renderMapFrame(state.timeIdx);
      if (state.streetId) loadStreetSeries(state.streetId, state.streetName);
    });
  });

  // 地图模式切换
  $('mapModeGroup').querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      $('mapModeGroup').querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      toggleMapMode(btn.dataset.mode);
    });
  });

  // 旋转开关
  $('btnRotate').addEventListener('click', toggleRotation);

  // 仅在用户拖拽（改变方位角）时暂停旋转，缩放不受影响
  let _rotWasActive = false;
  mlMap.on('dragstart', () => {
    _rotWasActive = _rotActive;
    if (_rotActive) stopRotation();
  });
  mlMap.on('dragend', () => {
    if (_rotWasActive) startRotation();
  });

  $('timeSlider').addEventListener('input', e => {
    state.timeIdx = +e.target.value;
    renderMapFrame(state.timeIdx);
  });

  $('btnPlay').addEventListener('click', togglePlay);

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.speed = +btn.dataset.speed;
      if (state.playing) { clearInterval(state._playTimer); startPlayTimer(); }
    });
  });

  $('btnTrain').addEventListener('click', startTraining);
  $('btnRetrain').addEventListener('click', resetTrainingPanel);
}

function togglePlay() {
  state.playing = !state.playing;
  $('btnPlay').textContent = state.playing ? '⏸' : '▶';
  state.playing ? startPlayTimer() : clearInterval(state._playTimer);
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
  const m = state.meta?.[id] || {};
  $('trainInfoBox').innerHTML =
    `<strong>${name}</strong>（${m.district || ''}）<br/>
     街道代码：<strong>${id}</strong><br/>
     位置：${m.ext_path || ''}`;
  $('trainHint').style.display   = 'none';
  $('trainReady').style.display  = 'block';
  $('trainResult').style.display = 'none';
  $('terminal').style.display    = 'none';
  $('trainBadge').className      = 'train-status-badge';
  $('trainBadge').textContent    = '待机';
  loadStreetSeries(id, name);
}

function stopSeriesAnimation() {
  if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
}

async function loadStreetSeries(id, name) {
  stopSeriesAnimation();
  $('seriesHint').style.display  = 'none';
  $('seriesChart').style.display = 'block';
  $('seriesTitle').textContent   = `${name} · 流量时序`;

  if (!seriesChart) {
    seriesChart = echarts.init($('seriesChart'), null, { renderer: 'canvas' });
    window.addEventListener('resize', () => seriesChart?.resize());
  }

  seriesChart.showLoading({
    text: '加载中...', color: '#00d4ff',
    textColor: '#94a3b8', maskColor: 'rgba(6,12,26,0.8)',
  });

  try {
    const urls = [
      `/api/street/${id}?net=5g&dir=down`,
      `/api/street/${id}?net=5g&dir=up`,
      `/api/street/${id}?net=4g&dir=down`,
      `/api/street/${id}?net=4g&dir=up`,
    ];
    const labels = ['5G 下行', '5G 上行', '4G 下行', '4G 上行'];
    const colors = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24'];
    const results = await Promise.allSettled(urls.map(u => fetchJSON(u)));

    let times = [];
    const rawSeries = [];
    results.forEach((res, i) => {
      if (res.status !== 'fulfilled' || res.value.error) return;
      const { times: t, values: v } = res.value;
      if (!times.length) times = t;
      rawSeries.push({ name: labels[i], color: colors[i], values: v });
    });

    _animData = { times, rawSeries };
    seriesChart.hideLoading();

    // 一次性静态配置
    seriesChart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      tooltip: {
        trigger: 'axis', className: 'echarts-tooltip',
        axisPointer: { type: 'cross', lineStyle: { color: '#1e3a5f' } },
        formatter(params) {
          let html = `<div style="font-size:11px;color:#94a3b8;margin-bottom:4px">${params[0]?.axisValue}</div>`;
          params.forEach(p => {
            if (p.value == null) return;
            html += `<div style="display:flex;justify-content:space-between;gap:16px">
              <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:4px"></span>${p.seriesName}</span>
              <strong>${p.value.toFixed(1)} MB</strong></div>`;
          });
          return html;
        },
      },
      legend: {
        data: rawSeries.map(s => s.name), top: 0, right: 4,
        textStyle: { color: '#94a3b8', fontSize: 10 },
        icon: 'circle', itemWidth: 8, itemHeight: 8,
      },
      grid: { top: 28, bottom: 28, left: 44, right: 12 },
      xAxis: {
        type: 'category', data: [],
        axisLabel: { color: '#4a6a8a', fontSize: 9,
          formatter: v => v.slice(5, 11), interval: 95 },
        axisLine: { lineStyle: { color: '#1e3a5f' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', name: 'MB',
        nameTextStyle: { color: '#4a6a8a', fontSize: 9 },
        axisLabel: { color: '#4a6a8a', fontSize: 9,
          formatter: v => v >= 1000 ? `${(v/1000).toFixed(1)}G` : `${v}` },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: '#1e3a5f', type: 'dashed' } },
      },
      series: rawSeries.map((s, i) => ({
        name: s.name, type: 'line', data: [], smooth: true,
        lineStyle: { color: s.color, width: 1.5 },
        itemStyle: { color: s.color },
        symbol: 'none',
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: hexToRgba(s.color, 0.25) },
              { offset: 1, color: 'rgba(0,0,0,0)' },
            ],
          },
          opacity: 0.4,
        },
        markLine: i === 0 ? {
          silent: true,
          symbol: ['none', 'none'],
          lineStyle: { color: 'rgba(96,165,250,0.5)', type: 'dashed', width: 1 },
          label: { show: true, formatter: '今日', color: '#60a5fa',
                   fontSize: 8, position: 'insideStartTop' },
          data: [],
        } : undefined,
      })),
    }, { notMerge: true });

    runSeriesAnimation();
  } catch (e) {
    seriesChart.hideLoading();
    console.error('时序加载失败:', e);
  }
}

/* ══════════════════════════════════════════════
   七天滚动动画（6天静态 + 第7天逐点播放）
══════════════════════════════════════════════ */
function runSeriesAnimation() {
  if (!_animData || !seriesChart) return;
  stopSeriesAnimation();

  const { times, rawSeries } = _animData;
  const DAY_PTS  = 96;           // 每天 96 个 15 分钟时间步
  const HIST_PTS = 6 * DAY_PTS;  // 前 6 天：576 个点（静态）
  const WIN_PTS  = 7 * DAY_PTS;  // 7 天窗口：672 个点
  const ANIM_MS  = 80;           // 每点间隔 ms（≈7.7s/天）

  if (times.length < WIN_PTS) return;

  let winStart = 0;

  function setFrame(nLive) {
    const t = times.slice(winStart, winStart + HIST_PTS + nLive);
    const boundaryTime = nLive > 0 ? times[winStart + HIST_PTS] : null;

    // 保留用户对 legend 的显示/隐藏选择，防止被每帧 setOption 覆盖
    const opts = seriesChart.getOption();
    const legendSelected = opts?.legend?.[0]?.selected;

    const update = {
      xAxis: { data: t },
      series: rawSeries.map((s, i) => {
        const obj = { data: s.values.slice(winStart, winStart + HIST_PTS + nLive) };
        if (i === 0) obj.markLine = { data: boundaryTime ? [{ xAxis: boundaryTime }] : [] };
        return obj;
      }),
    };
    if (legendSelected) update.legend = { selected: legendSelected };
    seriesChart.setOption(update);
  }

  function startWindow() {
    setFrame(0);
    let live = 0;
    const maxLive = Math.min(DAY_PTS, times.length - winStart - HIST_PTS);

    _animTimer = setInterval(() => {
      live++;
      setFrame(live);
      if (live >= maxLive) {
        clearInterval(_animTimer);
        _animTimer = null;
        const next = winStart + DAY_PTS;
        winStart = (next + WIN_PTS <= times.length) ? next : 0;
        setTimeout(startWindow, 1200); // 停顿 1.2s 后推进下一天
      }
    }, ANIM_MS);
  }

  startWindow();
}

/* ══════════════════════════════════════════════
   训练面板
══════════════════════════════════════════════ */
function startTraining() {
  if (!state.streetId) return;
  $('trainReady').style.display  = 'none';
  $('trainResult').style.display = 'none';
  $('terminal').style.display    = 'flex';
  $('trainBadge').className      = 'train-status-badge running';
  $('trainBadge').textContent    = '训练中';
  $('termTitle').textContent     = `LIGHTGBM · ${state.streetName} · ${state.net.toUpperCase()}`;
  $('termLog').innerHTML         = '';
  $('termProgressBar').style.width = '0%';
  $('termPct').textContent       = '0%';
  $('termIter').textContent      = 'Iter: 0 / 300';
  $('termRmse').textContent      = 'RMSE: —';
  $('termEta').textContent       = 'ETA: —';
  $('termPhaseLabel').textContent = '初始化...';
  startParticles();
  state.trainStart = Date.now();
  state.elapsedTimer = setInterval(updateElapsed, 1000);
  if (state.trainSSE) state.trainSSE.close();
  const url = `/api/train?id=${state.streetId}&net=${state.net}`;
  state.trainSSE = new EventSource(url);
  const metrics = {};
  state.trainSSE.onmessage = e => handleTrainMessage(JSON.parse(e.data), metrics);
  state.trainSSE.onerror   = () => {
    state.trainSSE.close();
    appendLog('连接断开', 'error', '');
    $('trainBadge').className   = 'train-status-badge error';
    $('trainBadge').textContent = '错误';
    stopElapsedTimer(); stopParticles();
  };
}

function handleTrainMessage(msg, metrics) {
  switch (msg.type) {
    case 'phase':
      $('termPhaseLabel').textContent = msg.msg;
      appendLog(msg.msg, 'phase', msg.time); break;
    case 'log':
      appendLog(msg.msg, msg.level || 'info', msg.time); break;
    case 'iter': {
      const { iter, total, pct, rmse, mae, eta, direction } = msg;
      $('termProgressBar').style.width = `${pct}%`;
      $('termPct').textContent  = `${Math.round(pct)}%`;
      $('termIter').textContent = `Iter: ${iter} / ${total}`;
      $('termRmse').textContent = `RMSE: ${rmse.toFixed(2)}`;
      $('termEta').textContent  = `ETA: ${formatSec(eta)}`;
      const dl = direction === 'down' ? '↓下行' : '↑上行';
      appendLog(
        `[${dl}] Iter ${String(iter).padStart(3)} / ${total}` +
        `  RMSE=${rmse.toFixed(4)}  MAE=${mae.toFixed(4)}  ETA=${formatSec(eta)}`,
        'iter', msg.time);
      break;
    }
    case 'metrics':
      metrics[msg.direction] = msg;
      appendLog(
        `✓ ${msg.label} 完成 | RMSE=${msg.rmse.toFixed(2)}MB  MAE=${msg.mae.toFixed(2)}MB  R²=${msg.r2.toFixed(3)}  MAPE=${msg.mape.toFixed(1)}%`,
        'success', msg.time);
      break;
    case 'done':
      state.trainSSE.close(); stopElapsedTimer();
      $('termProgressBar').style.width = '100%';
      $('termPct').textContent = '100%';
      $('termPhaseLabel').textContent = '训练完成！';
      $('termEta').textContent = 'ETA: 0s';
      appendLog('══ 全部训练完成 ══', 'success', msg.time);
      $('trainBadge').className   = 'train-status-badge done';
      $('trainBadge').textContent = '完成';
      setTimeout(() => { showTrainingResults(metrics, msg.results); stopParticles(); }, 800);
      break;
    case 'error':
      appendLog(`错误: ${msg.msg}`, 'error', msg.time);
      $('trainBadge').className   = 'train-status-badge error';
      $('trainBadge').textContent = '错误';
      stopElapsedTimer(); stopParticles(); state.trainSSE.close();
      break;
  }
}

function appendLog(msg, level, ts) {
  const log  = $('termLog');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML =
    `<span class="log-ts">[${ts || nowStr()}]</span>` +
    `<span class="log-prompt">›</span>` +
    `<span class="log-msg level-${level}">${escHtml(msg)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 200) log.removeChild(log.firstChild);
}

function showTrainingResults(metrics, predResults) {
  $('terminal').style.display    = 'none';
  $('trainResult').style.display = 'block';
  const grid = $('metricsGrid');
  grid.innerHTML = '';
  const defs = [
    { key: 'rmse', label: 'RMSE', unit: 'MB' },
    { key: 'mae',  label: 'MAE',  unit: 'MB' },
    { key: 'r2',   label: 'R²',   unit: '' },
    { key: 'mape', label: 'MAPE', unit: '%' },
  ];
  ['down', 'up'].forEach(d => {
    const m = metrics[d]; if (!m) return;
    const hdr = document.createElement('div');
    hdr.style.cssText = 'grid-column:1/-1;font-size:10px;color:var(--text-dim);padding:4px 0 2px;text-transform:uppercase;letter-spacing:1px';
    hdr.textContent = `${state.net.toUpperCase()} ${d === 'down' ? '↓ 下行' : '↑ 上行'}`;
    grid.appendChild(hdr);
    defs.forEach(({ key, label, unit }) => {
      const card = document.createElement('div');
      card.className = 'metric-card';
      card.innerHTML =
        `<div class="metric-label">${label}</div>` +
        `<div class="metric-value">${typeof m[key] === 'number' ? m[key].toFixed(key === 'mape' ? 1 : 3) : '—'}</div>` +
        `<div class="metric-sub">${unit}</div>`;
      grid.appendChild(card);
    });
  });
  buildPredChart(predResults);
}

function buildPredChart(predResults) {
  if (!predChart) {
    predChart = echarts.init($('predChart'), null, { renderer: 'canvas' });
    window.addEventListener('resize', () => predChart?.resize());
  }
  const colorMap = { down: ['#60a5fa', '#93c5fd'], up: ['#34d399', '#6ee7b7'] };
  const series = [];
  let times = [];
  Object.entries(predResults || {}).forEach(([dir, data]) => {
    if (!data) return;
    if (!times.length) times = data.times;
    const [cA, cP] = colorMap[dir] || ['#fff', '#888'];
    const lbl = dir === 'down' ? '下行' : '上行';
    series.push({
      name: `${lbl} 实际`, type: 'line', data: data.actual,
      lineStyle: { color: cA, width: 1.5 }, itemStyle: { color: cA }, symbol: 'none',
    });
    series.push({
      name: `${lbl} 预测`, type: 'line', data: data.pred,
      lineStyle: { color: cP, width: 1.5, type: 'dashed' }, itemStyle: { color: cP }, symbol: 'none', smooth: true,
    });
  });
  predChart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis', className: 'echarts-tooltip',
      axisPointer: { type: 'cross', lineStyle: { color: '#1e3a5f' } } },
    legend: { top: 0, right: 4, textStyle: { color: '#94a3b8', fontSize: 9 }, icon: 'circle', itemWidth: 7, itemHeight: 7 },
    grid: { top: 24, bottom: 4, left: 40, right: 10 },
    xAxis: { type: 'category', data: times,
      axisLabel: { color: '#4a6a8a', fontSize: 8, formatter: v => v.slice(0, 5),
        interval: Math.floor(times.length / 4) },
      axisLine: { lineStyle: { color: '#1e3a5f' } }, splitLine: { show: false } },
    yAxis: { type: 'value',
      axisLabel: { color: '#4a6a8a', fontSize: 8 }, axisLine: { show: false },
      splitLine: { lineStyle: { color: '#1e3a5f', type: 'dashed' } } },
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

function updateElapsed() {
  $('termElapsed').textContent = formatSec((Date.now() - state.trainStart) / 1000, true);
}
function stopElapsedTimer() {
  clearInterval(state.elapsedTimer);
  state.elapsedTimer = null;
}

/* ── 粒子效果 ────────────────────────────────── */
let _pRAF = null, _pCtx = null, _pts = [];

function startParticles() {
  const canvas = $('particleCanvas');
  if (!canvas) return;
  _pCtx = canvas.getContext('2d');
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  const N = 60;
  _pts = Array.from({ length: N }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.4,
    vy: -Math.random() * 0.6 - 0.2,
    r:  Math.random() * 1.5 + 0.3,
    a:  Math.random(),
  }));
  function draw() {
    const c = _pCtx, w = canvas.width, h = canvas.height;
    c.clearRect(0, 0, w, h);
    _pts.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.a -= 0.003;
      if (p.a <= 0 || p.y < 0) {
        p.x = Math.random() * w; p.y = h + 2;
        p.vy = -Math.random() * 0.6 - 0.2; p.a = Math.random();
      }
      c.beginPath(); c.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      c.fillStyle = `rgba(0,255,136,${p.a.toFixed(2)})`; c.fill();
      _pts.forEach(q => {
        const dx = p.x - q.x, dy = p.y - q.y, d = Math.sqrt(dx*dx + dy*dy);
        if (d < 60) {
          c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(q.x, q.y);
          c.strokeStyle = `rgba(0,180,90,${(0.15*(1-d/60)).toFixed(3)})`; c.lineWidth = 0.5; c.stroke();
        }
      });
    });
    _pRAF = requestAnimationFrame(draw);
  }
  draw();
}

function stopParticles() {
  if (_pRAF) { cancelAnimationFrame(_pRAF); _pRAF = null; }
  if (_pCtx) {
    const c = $('particleCanvas');
    if (c) _pCtx.clearRect(0, 0, c.width, c.height);
    _pCtx = null;
  }
}

/* ══════════════════════════════════════════════
   拖拽分割条
══════════════════════════════════════════════ */
function initResizer() {
  const resizer = $('resizer');
  const sidebar = $('sidebar');
  if (!resizer || !sidebar) return;

  let dragging = false;
  let startX   = 0;
  let startW   = 0;

  resizer.addEventListener('mousedown', e => {
    dragging = true;
    startX   = e.clientX;
    startW   = sidebar.getBoundingClientRect().width;
    resizer.classList.add('active');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta  = startX - e.clientX;
    const layout = document.querySelector('.main-layout');
    const total  = layout.getBoundingClientRect().width;
    const minMap     = 280;
    const minSidebar = 260;
    const maxSidebar = total - minMap - 12;
    const newW = Math.min(Math.max(startW + delta, minSidebar), maxSidebar);
    sidebar.style.flex = `0 0 ${newW}px`;
    requestAnimationFrame(() => {
      mlMap?.resize();
      seriesChart?.resize();
      predChart?.resize();
    });
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('active');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    requestAnimationFrame(() => {
      mlMap?.resize();
      seriesChart?.resize();
      predChart?.resize();
    });
  });

  // 双击恢复默认宽度
  resizer.addEventListener('dblclick', () => {
    sidebar.style.flex = '0 0 380px';
    requestAnimationFrame(() => {
      mlMap?.resize();
      seriesChart?.resize();
      predChart?.resize();
    });
  });
}

/* ══════════════════════════════════════════════
   移动端 Tab 切换
══════════════════════════════════════════════ */
function initMobileTabs() {
  const tabs = document.querySelectorAll('.mobile-tab');
  if (!tabs.length) return;
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.target;
      ['seriesPanel', 'trainPanel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('mobile-hidden', id !== target);
      });
      setTimeout(() => { seriesChart?.resize(); predChart?.resize(); }, 80);
    });
  });
}

/* ══════════════════════════════════════════════
   启动
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', init);
