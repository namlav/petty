'use strict';

const $ = (id) => document.getElementById(id);

const MAX_CHART_POINTS = 40;
const MAX_LOG_ROWS = 60;
const STALE_MS = 15000;

const STATUS_LABEL = ['Idle', 'Feeding', 'Offline-Synced', 'Error'];
const ERROR_LABEL = ['OK', 'Jammed', 'Empty tank', 'Sensor fault'];

const state = {
  socket: null,
  token: localStorage.getItem('petty.token') || '',
  reconnectDelay: 1000,
  lastTelemetryAt: 0,
  lastWeight: null,
  seen: new Set(),
  consumption: new Array(24).fill(0),
  liveChart: null,
  consumptionChart: null,
  toastTimer: null,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function formatTime(isoString) {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime())
    ? '--:--:--'
    : date.toLocaleTimeString('vi-VN', { hour12: false });
}

function setGateway(kind, text) {
  const conn = document.querySelector('.conn');
  conn.classList.toggle('online', kind === 'online');
  conn.classList.toggle('error', kind === 'error');
  $('wsLabel').textContent = text;
}

function notify(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

// ------------------------------------------------------------
// WebSocket
// ------------------------------------------------------------
function connect() {
  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }

  const host = location.host || 'localhost:8080';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const query = `role=dashboard&token=${encodeURIComponent(state.token)}`;
  const socket = new WebSocket(`${scheme}://${host}/ws?${query}`);
  state.socket = socket;

  setGateway('pending', 'Đang kết nối gateway…');

  socket.addEventListener('open', () => {
    state.reconnectDelay = 1000;
    setGateway('online', 'Gateway đã kết nối');
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  });

  socket.addEventListener('close', (event) => {
    if (event.code === 4001) {
      setGateway('error', 'JWT token không hợp lệ');
      return;
    }
    setGateway('offline', 'Mất kết nối gateway · đang thử lại');
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15000);
  });

  socket.addEventListener('error', () => {
    setGateway('error', 'Lỗi kết nối gateway');
  });
}

function handleMessage(message) {
  switch (message.type) {
    case 'snapshot': {
      const data = message.data || {};
      (data.recent || []).forEach(applyRecord);
      if (data.schedule) {
        renderSchedule(data.schedule);
      }
      break;
    }
    case 'telemetry':
      applyRecord(message.data);
      break;
    case 'schedule':
      renderSchedule(message.data);
      break;
    case 'error':
      notify(`Lỗi: ${message.error}`);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------
// Telemetry -> UI
// ------------------------------------------------------------
function applyRecord(record) {
  if (!record) {
    return;
  }
  const key = `${record.device_id}:${record.seq_num}`;
  if (state.seen.has(key)) {
    return;
  }
  state.seen.add(key);
  if (state.seen.size > 3000) {
    state.seen.delete(state.seen.values().next().value);
  }

  state.lastTelemetryAt = Date.now();

  $('weight').textContent = Number(record.weight_g).toFixed(1);
  $('level').textContent = record.food_level;
  $('levelBar').style.width = `${clamp(Number(record.food_level), 0, 100)}%`;
  $('buffered').textContent = record.buffered || 0;
  $('lastSeen').textContent = `Cập nhật ${formatTime(record.recorded_at)}`;

  // Thú cưng ăn làm khối lượng bát giảm -> cộng dồn theo giờ.
  if (state.lastWeight !== null && record.weight_g < state.lastWeight - 0.5) {
    const hour = new Date(record.recorded_at).getHours();
    state.consumption[hour] += state.lastWeight - record.weight_g;
    updateConsumptionChart();
  }
  state.lastWeight = record.weight_g;

  updateDeviceState(record);
  pushLivePoint(record);
  addLogRow(record);
}

function updateDeviceState(record) {
  let label = 'ONLINE';
  let cls = 'online';

  if (record.status === 2) {
    label = 'SYNCING';
    cls = 'syncing';
  } else if (record.status === 3) {
    label = 'ERROR';
    cls = 'error';
  }
  if (record.error_code) {
    label += ` · ${ERROR_LABEL[record.error_code] || `E${record.error_code}`}`;
  }

  const element = $('deviceState');
  element.textContent = label;
  element.className = `pill ${cls}`;
}

function checkStale() {
  if (!state.lastTelemetryAt) {
    return;
  }
  if (Date.now() - state.lastTelemetryAt < STALE_MS) {
    return;
  }
  const element = $('deviceState');
  element.textContent = 'OFFLINE BUFFERING';
  element.className = 'pill offline';
}

function renderSchedule(schedule) {
  if (!schedule) {
    return;
  }
  const pad = (value) => String(value).padStart(2, '0');
  const time = `${pad(schedule.hour)}:${pad(schedule.minute)}`;
  $('scheduleInfo').textContent = `Lịch: ${time} · ${schedule.grams} g · ${
    schedule.enabled ? 'đang bật' : 'đang tắt'
  }`;
  $('schedTime').value = time;
  $('schedGrams').value = schedule.grams;
  $('schedEnabled').checked = Boolean(schedule.enabled);
}

// ------------------------------------------------------------
// Log table
// ------------------------------------------------------------
function addLogRow(record) {
  const body = $('logBody');
  if (body.querySelector('td[colspan]')) {
    body.innerHTML = '';
  }

  const row = document.createElement('tr');
  if (record.synced) {
    row.className = 'synced';
  }

  const values = [
    formatTime(record.recorded_at),
    record.seq_num,
    `${Number(record.weight_g).toFixed(1)} g`,
    `${record.food_level} %`,
    STATUS_LABEL[record.status] || record.status,
    ERROR_LABEL[record.error_code] || record.error_code,
  ];
  values.forEach((value) => {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(cell);
  });

  const sourceCell = document.createElement('td');
  const tag = document.createElement('span');
  tag.className = `tag${record.synced ? ' sync' : ''}`;
  tag.textContent = record.synced ? 'SYNC' : 'LIVE';
  sourceCell.appendChild(tag);
  row.appendChild(sourceCell);

  body.prepend(row);
  while (body.children.length > MAX_LOG_ROWS) {
    body.lastElementChild.remove();
  }
}

// ------------------------------------------------------------
// Charts
// ------------------------------------------------------------
function initCharts() {
  if (typeof Chart === 'undefined') {
    document.querySelectorAll('.chart-wrap').forEach((wrap) => {
      wrap.innerHTML =
        '<p class="muted">Không tải được Chart.js — cần Internet cho CDN.</p>';
    });
    return;
  }

  Chart.defaults.color = '#64748b';
  Chart.defaults.font.family = '"Segoe UI", system-ui, sans-serif';

  state.liveChart = new Chart($('liveChart'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Khối lượng bát (g)',
          data: [],
          borderColor: '#0f766e',
          backgroundColor: 'rgba(15, 118, 110, 0.12)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          yAxisID: 'y',
        },
        {
          label: 'Mức hạt (%)',
          data: [],
          borderColor: '#f59e0b',
          borderDash: [5, 4],
          tension: 0.3,
          pointRadius: 2,
          yAxisID: 'y1',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', title: { display: true, text: 'gam' } },
        y1: {
          position: 'right',
          min: 0,
          max: 100,
          grid: { drawOnChartArea: false },
          title: { display: true, text: '%' },
        },
      },
    },
  });

  state.consumptionChart = new Chart($('consumptionChart'), {
    type: 'bar',
    data: {
      labels: [...Array(24).keys()].map((hour) => `${hour}h`),
      datasets: [
        {
          label: 'Thức ăn tiêu thụ (g)',
          data: state.consumption,
          backgroundColor: '#14b8a6',
          borderRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'gam' } } },
    },
  });
}

function pushLivePoint(record) {
  const chart = state.liveChart;
  if (!chart) {
    return;
  }
  chart.data.labels.push(formatTime(record.recorded_at));
  chart.data.datasets[0].data.push(Number(record.weight_g));
  chart.data.datasets[1].data.push(Number(record.food_level));
  while (chart.data.labels.length > MAX_CHART_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach((dataset) => dataset.data.shift());
  }
  chart.update('none');
}

function updateConsumptionChart() {
  if (!state.consumptionChart) {
    return;
  }
  state.consumptionChart.data.datasets[0].data = [...state.consumption];
  state.consumptionChart.update('none');
}

// ------------------------------------------------------------
// REST commands
// ------------------------------------------------------------
async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    notify(`Lỗi: ${error.message}`);
    return null;
  }
}

// ------------------------------------------------------------
// Khởi động
// ------------------------------------------------------------
function init() {
  $('token').value = state.token;

  $('connectBtn').addEventListener('click', () => {
    state.token = $('token').value.trim();
    localStorage.setItem('petty.token', state.token);
    connect();
  });

  $('feedBtn').addEventListener('click', async () => {
    const grams = clamp(Number($('feedGrams').value) || 30, 1, 200);
    const result = await postJson('/api/feed', { grams });
    if (result) {
      notify(
        result.ok
          ? `Đã gửi lệnh cho ăn ${grams} g`
          : 'Không có thiết bị nào đang online'
      );
    }
  });

  $('stopBtn').addEventListener('click', async () => {
    const result = await postJson('/api/stop', {});
    if (result) {
      notify(
        result.ok ? 'Đã gửi lệnh dừng khẩn cấp' : 'Không có thiết bị nào đang online'
      );
    }
  });

  $('scheduleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const [hour, minute] = $('schedTime').value.split(':').map(Number);
    const body = {
      enabled: $('schedEnabled').checked,
      hour: Number.isFinite(hour) ? hour : 0,
      minute: Number.isFinite(minute) ? minute : 0,
      grams: clamp(Number($('schedGrams').value) || 30, 1, 200),
    };
    const result = await postJson('/api/schedule', body);
    if (result) {
      renderSchedule(result.schedule || body);
      notify('Đã lưu lịch hẹn');
    }
  });

  initCharts();
  connect();
  setInterval(checkStale, 3000);
}

init();
