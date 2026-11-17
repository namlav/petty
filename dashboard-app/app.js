'use strict';

const $ = (id) => document.getElementById(id);

const MAX_CHART_POINTS = 40;
const MAX_LOG_ROWS = 60;
const STALE_MS = 15000;

const STATUS_LABEL = ['Idle', 'Feeding', 'Offline-Synced', 'Error'];
const ERROR_LABEL = ['OK', 'Jammed', 'Empty tank', 'Sensor fault'];

const state = {
  socket: null,
  token: new URLSearchParams(location.search).get('token') || '',
  reconnectDelay: 1000,
  lastTelemetryAt: 0,
  deviceId: null,
  gatewayDeviceOnline: null,
  bowlCapacity: 120,
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
      applyDeviceStatus(data.devices || []);
      if (data.schedule) {
        renderSchedule(data.schedule);
      }
      break;
    }
    case 'status':
      applyDeviceStatus(message.devices || []);
      break;
    case 'telemetry':
      applyRecord(message.data);
      break;
    case 'schedule':
      renderSchedule(message.data);
      break;
    case 'device_config':
      if (!state.deviceId || message.data?.device_id === state.deviceId) {
        setBowlCapacity(message.data?.bowl_capacity_g);
      }
      break;
    case 'error':
      notify(`Lỗi: ${message.error === 'bowl_full' ? 'Bát đã đầy, không thể xả thêm' : message.error === 'device_jammed' ? 'Thiết bị đang kẹt hạt, hãy kiểm tra và Xóa lỗi trước' : message.error}`);
      break;
    case 'alert':
      notify(message.data?.message || 'Có cảnh báo mới');
      break;
    default:
      break;
  }
}

function applyDeviceStatus(devices) {
  if (!state.deviceId) {
    state.deviceId = devices.find((device) => device.id === 'esp01')?.id || devices[0]?.id || 'esp01';
  }
  const device = devices.find((item) => item.id === state.deviceId);
  if (!device) {
    state.gatewayDeviceOnline = false;
    setDevicePresence(false, null);
    return;
  }
  state.gatewayDeviceOnline = Boolean(device.online);
  if (device.bowl_capacity_g != null) {
    setBowlCapacity(device.bowl_capacity_g);
  }
  const simCheck = $('simJamCheck');
  if (simCheck && device.sim_jam !== undefined) {
    simCheck.checked = Boolean(device.sim_jam);
  }
  setDevicePresence(state.gatewayDeviceOnline, device.last_seen);
}

function setBowlCapacity(value) {
  const cap = Number(value);
  if (!Number.isFinite(cap) || cap < 50) return;
  state.bowlCapacity = cap;
  const label = $('bowlCapLabel');
  if (label) label.textContent = cap;
  const input = $('bowlCapacity');
  if (input && document.activeElement !== input) {
    input.value = cap;
  }
}

function setDevicePresence(online, lastSeen) {
  const element = $('deviceState');
  element.textContent = online ? 'ONLINE' : 'OFFLINE';
  element.className = `pill ${online ? 'online' : 'offline'}`;
  if (lastSeen) $('lastSeen').textContent = `Cập nhật ${formatTime(lastSeen)}`;
}

// ------------------------------------------------------------
// Telemetry -> UI
// ------------------------------------------------------------
function applyRecord(record) {
  if (!record) {
    return;
  }
  if (Number(record.seq_num) === 1 && !record.synced) {
    state.seen.clear();
  }
  const key = `${record.device_id}:${record.seq_num}:${record.recorded_at || ''}`;
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
  state.deviceId = record.device_id || state.deviceId;
  state.gatewayDeviceOnline = true;
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
  if (state.gatewayDeviceOnline === false) {
    setDevicePresence(false, null);
    return;
  }
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
async function requestJson(method, url, body) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const msg = payload.error === 'bowl_full'
        ? `Bát đã đầy (${Number(payload.bowl_weight_g || 0).toFixed(1)} / ${payload.bowl_capacity_g || state.bowlCapacity} g), từ chối xả thêm`
        : payload.error === 'device_jammed'
          ? 'Thiết bị đang bị kẹt hạt, hãy kiểm tra và Xóa lỗi trước'
          : (payload.error || `HTTP ${response.status}`);
      throw new Error(msg);
    }
    return await response.json();
  } catch (error) {
    notify(`Lỗi: ${error.message}`);
    return null;
  }
}

const postJson = (url, body) => requestJson('POST', url, body);

// ------------------------------------------------------------
// Khởi động
// ------------------------------------------------------------
function init() {
  localStorage.removeItem('petty.token');
  localStorage.removeItem('petty.simJam');

  $('feedBtn').addEventListener('click', async () => {
    if (state.lastWeight !== null && state.lastWeight >= state.bowlCapacity) {
      notify(`Bát còn đầy (${Number(state.lastWeight).toFixed(1)} / ${state.bowlCapacity} g), từ chối xả thêm`);
      return;
    }
    const grams = clamp(Number($('feedGrams').value) || 30, 1, 1000);
    const result = await postJson('/api/feed', {
      device: state.deviceId || 'esp01',
      grams,
    });
    if (result) {
      if (!result.ok) {
        notify('Không có thiết bị nào đang online');
      } else if (result.clamped) {
        notify(`Bát sắp đầy: tự cắt còn ${result.grams} g (vừa đầy ${result.bowl_capacity_g} g)`);
      } else {
        notify(`Đã gửi lệnh cho ăn ${result.grams} g`);
      }
    }
  });

  $('saveCapacityBtn').addEventListener('click', async () => {
    const cap = Number($('bowlCapacity').value);
    if (!Number.isFinite(cap) || cap < 50 || cap > 1000) {
      notify('Dung tích bát phải nằm trong khoảng 50–1000 g');
      return;
    }
    const id = encodeURIComponent(state.deviceId || 'esp01');
    const result = await requestJson('PUT', `/api/devices/${id}/config`, {
      bowl_capacity_g: cap,
    });
    if (result) {
      setBowlCapacity(result.bowl_capacity_g);
      notify(`Đã lưu dung tích bát: ${result.bowl_capacity_g} g`);
    }
  });

  $('stopBtn').addEventListener('click', async () => {
    const result = await postJson('/api/stop', { device: state.deviceId || 'esp01' });
    if (result) {
      notify(
        result.ok ? 'Đã gửi lệnh dừng khẩn cấp' : 'Không có thiết bị nào đang online'
      );
    }
  });

  $('clearErrorBtn').addEventListener('click', () => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      notify('Chưa kết nối tới Gateway');
      return;
    }
    $('simJamCheck').checked = false;
    state.socket.send(JSON.stringify({ cmd: 'CLEAR_ERROR', device: state.deviceId || 'esp01' }));
    notify('Đã xóa lỗi & tắt giả lập kẹt hạt');
  });

  $('simJamCheck').addEventListener('change', () => {
    const on = Boolean($('simJamCheck').checked);
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      $('simJamCheck').checked = !on;
      notify('Chưa kết nối tới Gateway');
      return;
    }
    state.socket.send(JSON.stringify({ cmd: 'SIM_JAM', on, device: state.deviceId || 'esp01' }));
    notify(on ? 'Đã bật giả lập kẹt hạt' : 'Đã tắt giả lập kẹt hạt (chế độ bình thường)');
  });

  $('simEatBtn').addEventListener('click', () => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      notify('Chưa kết nối tới Gateway');
      return;
    }
    state.socket.send(JSON.stringify({ cmd: 'SIM_EAT', device: state.deviceId || 'esp01' }));
    notify('Đã mô phỏng thú cưng ăn hết bát');
  });

  $('simRefillBtn').addEventListener('click', () => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      notify('Chưa kết nối tới Gateway');
      return;
    }
    state.socket.send(JSON.stringify({ cmd: 'SIM_REFILL', device: state.deviceId || 'esp01' }));
    notify('Đã mô phỏng đổ đầy bồn hạt (100%)');
  });

  $('scheduleForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const [hour, minute] = $('schedTime').value.split(':').map(Number);
    const body = {
      enabled: $('schedEnabled').checked,
      hour: Number.isFinite(hour) ? hour : 0,
      minute: Number.isFinite(minute) ? minute : 0,
      grams: clamp(Number($('schedGrams').value) || 30, 1, 1000),
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
