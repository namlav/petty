/**
 * [SV2 + SV3] WebSocket Gateway
 *  - Nhận telemetry Compact JSON từ ESP32 (qua WebSocket)
 *  - Gửi ACK {"ack": seq} để ESP32 pop Ring Buffer
 *  - Broadcast realtime lên dashboard
 *  - Đồng bộ telemetry lên Supabase (REST, tuỳ chọn)
 *  - Xác thực JWT + RBAC (admin / owner / viewer / device)
 */
'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || '';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'dev-device-token';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
// Append-only local spool: ACK chỉ sau khi bản ghi đã được fsync xuống đĩa.
const SPOOL_PATH = process.env.TELEMETRY_SPOOL_PATH || path.join(__dirname, 'telemetry-spool.jsonl');

// ------------------------------------------------------------
// JWT (HS256) bằng crypto có sẵn - không thêm dependency
// ------------------------------------------------------------
const base64url = (value) => Buffer.from(value).toString('base64url');

function signToken(payload, expiresInSeconds = 3600) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({
      ...payload,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    })
  );
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  // Chưa cấu hình JWT_SECRET => chế độ demo, cho phép toàn quyền.
  if (!JWT_SECRET) {
    return { role: 'admin', sub: 'demo' };
  }
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, body, signature] = parts;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

function deviceAuthorized(token) {
  if (token === DEVICE_TOKEN) {
    return true;
  }
  const claims = verifyToken(token);
  return Boolean(claims && claims.role === 'device');
}

function auth(allowedRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = verifyToken(token);
    if (!claims) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (allowedRoles && !allowedRoles.includes(claims.role)) {
      return res.status(403).json({ error: 'forbidden', role: claims.role });
    }
    req.user = claims;
    return next();
  };
}

// ------------------------------------------------------------
// Trạng thái in-memory
// ------------------------------------------------------------
const deviceSockets = new Set();
const dashboardSockets = new Set();
const recentTelemetry = [];
const seenPackets = new Set();
const pendingSpool = [];
let flushingSpool = false;
const MAX_RECENT = 500;
const MAX_SEEN = 5000;

function loadSpool() {
  if (!fs.existsSync(SPOOL_PATH)) return;
  const text = fs.readFileSync(SPOOL_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      pendingSpool.push(record);
      rememberPacket(`${record.device_id}:${record.seq_num}`);
    } catch (error) {
      console.error('[SPOOL] Bỏ qua dòng hỏng:', error.message);
    }
  }
  console.log(`[SPOOL] Khôi phục ${pendingSpool.length} bản ghi chờ`);
}

function appendSpool(record) {
  try {
    fs.mkdirSync(path.dirname(SPOOL_PATH), { recursive: true });
    const fd = fs.openSync(SPOOL_PATH, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    pendingSpool.push(record);
    return true;
  } catch (error) {
    console.error('[SPOOL] Không ghi bền được telemetry:', error.message);
    return false;
  }
}

function compactSpool() {
  const temporary = `${SPOOL_PATH}.tmp`;
  const content = pendingSpool.map((record) => JSON.stringify(record)).join('\n');
  const fd = fs.openSync(temporary, 'w');
  try {
    if (content) fs.writeSync(fd, `${content}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, SPOOL_PATH);
}

let schedule = { enabled: false, hour: 8, minute: 0, grams: 30 };

// ------------------------------------------------------------
// Express REST API
// ------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'dashboard-app')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    devices: deviceSnapshot(),
    dashboards: dashboardSockets.size,
    buffered_records: pendingSpool.length,
    supabase: Boolean(SUPABASE_URL && SUPABASE_KEY),
  });
});

app.get('/api/telemetry', auth(['admin', 'owner', 'viewer']), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, MAX_RECENT);
  res.json({ data: recentTelemetry.slice(-limit) });
});

app.get('/api/schedule', auth(['admin', 'owner', 'viewer']), (req, res) => {
  res.json({ data: schedule });
});

app.post('/api/feed', auth(['admin', 'owner']), (req, res) => {
  const grams = Math.max(1, Math.min(200, Number(req.body?.grams) || 30));
  const sent = sendToDevices({ cmd: 'FEED', g: grams });
  console.log(`[CMD] FEED ${grams}g -> ${sent} thiet bi`);
  res.json({ ok: sent > 0, sent, grams });
});

app.post('/api/stop', auth(['admin', 'owner']), (req, res) => {
  const sent = sendToDevices({ cmd: 'STOP' });
  console.log(`[CMD] STOP -> ${sent} thiet bi`);
  res.json({ ok: sent > 0, sent });
});

app.post('/api/schedule', auth(['admin', 'owner']), (req, res) => {
  const body = req.body || {};
  schedule = {
    enabled: Boolean(body.enabled),
    hour: Math.max(0, Math.min(23, Number(body.hour) || 0)),
    minute: Math.max(0, Math.min(59, Number(body.minute) || 0)),
    grams: Math.max(1, Math.min(200, Number(body.grams) || 30)),
  };
  const sent = sendToDevices({
    cmd: 'SET_SCHEDULE',
    h: schedule.hour,
    m: schedule.minute,
    g: schedule.grams,
    on: schedule.enabled,
  });
  broadcast({ type: 'schedule', data: schedule });
  console.log(
    `[CMD] SCHEDULE ${schedule.enabled ? 'ON' : 'OFF'} ` +
      `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} ` +
      `${schedule.grams}g -> ${sent} thiet bi`
  );
  res.json({ ok: true, sent, schedule });
});

// ------------------------------------------------------------
// WebSocket
// ------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of dashboardSockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function sendToDevices(command) {
  const data = JSON.stringify(command);
  let sent = 0;
  for (const device of deviceSockets) {
    if (device.readyState === WebSocket.OPEN) {
      device.send(data);
      sent++;
    }
  }
  return sent;
}

function deviceSnapshot() {
  return [...deviceSockets]
    .filter((socket) => socket.readyState === WebSocket.OPEN)
    .map((socket) => ({ id: socket.deviceId || 'unknown', online: true }));
}

function broadcastDeviceStatus() {
  broadcast({ type: 'status', devices: deviceSnapshot() });
}

function rememberPacket(key) {
  if (seenPackets.has(key)) {
    return false;
  }
  seenPackets.add(key);
  if (seenPackets.size > MAX_SEEN) {
    seenPackets.delete(seenPackets.values().next().value);
  }
  return true;
}

loadSpool();
flushSpool();
setInterval(flushSpool, 5000).unref();

function onTelemetry(socket, message) {
  if (message.hello) {
    socket.deviceId = String(message.hello);
    console.log(`[WS] Thiet bi ${socket.deviceId} dang ky`);
    broadcastDeviceStatus();
    return;
  }

  const seq = Number(message.s);
  const deviceId = String(message.id || socket.deviceId || 'unknown');
  if (!Number.isFinite(seq)) {
    console.warn('[WS] Goi tin khong hop le:', message);
    return;
  }
  socket.deviceId = deviceId;

  const packetKey = `${deviceId}:${seq}`;
  if (seenPackets.has(packetKey)) {
    // Gói retry đã được spool bền trước đó, có thể ACK an toàn.
    socket.send(JSON.stringify({ ack: seq }));
    return; // đã lưu trước đó (retransmit / sync trùng)
  }

  const timestamp = Number(message.t) || Math.floor(Date.now() / 1000);
  const record = {
    device_id: deviceId,
    seq_num: seq,
    recorded_at: new Date(timestamp * 1000).toISOString(),
    weight_g: Number(message.w) || 0,
    food_level: Number(message.l) || 0,
    status: Number(message.st) || 0,
    error_code: Number(message.e) || 0,
    buffered: Number(message.q) || 0,
    synced: Number(message.st) === 2,
    raw: message,
  };

  // Không ACK nếu không thể lưu bền tại gateway; ESP32 sẽ gửi lại sau timeout.
  if (!appendSpool(record)) return;
  rememberPacket(packetKey);
  socket.send(JSON.stringify({ ack: seq }));

  recentTelemetry.push(record);
  if (recentTelemetry.length > MAX_RECENT) {
    recentTelemetry.shift();
  }

  if (record.synced) {
    console.log(
      `[SYNC] ${deviceId} seq=${seq} t=${record.recorded_at} ` +
        `w=${record.weight_g}g l=${record.food_level}% e=${record.error_code}`
    );
  } else {
    console.log(
      `[RX]   ${deviceId} seq=${seq} w=${record.weight_g}g ` +
        `l=${record.food_level}% st=${record.status} e=${record.error_code}`
    );
  }

  broadcast({ type: 'telemetry', data: record });
  flushSpool();
}

async function persistTelemetry(record) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return false;
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/telemetry_logs`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        // UNIQUE(device_id, seq_num) chống ghi trùng khi ESP32 sync lại.
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({
        device_id: record.device_id,
        seq_num: record.seq_num,
        recorded_at: record.recorded_at,
        weight_g: record.weight_g,
        food_level: record.food_level,
        status: record.status,
        error_code: record.error_code,
        synced: record.synced,
        raw: record.raw,
      }),
    });
    if (!response.ok) {
      console.error('[SUPABASE]', response.status, await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error('[SUPABASE]', error.message);
    return false;
  }
}

async function flushSpool() {
  if (flushingSpool || !SUPABASE_URL || !SUPABASE_KEY) return;
  flushingSpool = true;
  try {
    while (pendingSpool.length > 0) {
      const record = pendingSpool[0];
      if (!(await persistTelemetry(record))) break;
      pendingSpool.shift();
      // Rewrite after each success: a crash can cause replay, while the DB key
      // UNIQUE(device_id, seq_num) makes that replay idempotent.
      compactSpool();
    }
  } catch (error) {
    console.error('[SPOOL] Flush lỗi:', error.message);
  } finally {
    flushingSpool = false;
  }
}

function onDashboardCommand(socket, message) {
  const role = socket.user?.role || 'viewer';
  if (!['admin', 'owner'].includes(role)) {
    socket.send(JSON.stringify({ type: 'error', error: 'forbidden' }));
    return;
  }
  const cmd = String(message.cmd || '').toUpperCase();
  if (cmd === 'FEED') {
    sendToDevices({ cmd: 'FEED', g: Number(message.g) || 30 });
  } else if (cmd === 'STOP') {
    sendToDevices({ cmd: 'STOP' });
  } else if (cmd === 'CLEAR_ERROR') {
    sendToDevices({ cmd: 'CLEAR_ERROR' });
  } else {
    socket.send(JSON.stringify({ type: 'error', error: 'unknown command' }));
  }
}

wss.on('connection', (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const role = url.searchParams.get('role') || 'dashboard';
  const token = url.searchParams.get('token') || '';

  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  if (role === 'device') {
    if (!deviceAuthorized(token)) {
      console.warn('[WS] Tu choi thiet bi: sai DEVICE_TOKEN');
      socket.close(4001, 'invalid device token');
      return;
    }
    socket.role = 'device';
    deviceSockets.add(socket);
    console.log('[WS] Thiet bi ket noi');
    broadcastDeviceStatus();
  } else {
    const claims = verifyToken(token);
    if (!claims) {
      socket.close(4001, 'invalid token');
      return;
    }
    socket.role = 'dashboard';
    socket.user = claims;
    dashboardSockets.add(socket);
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        data: {
          devices: deviceSnapshot(),
          recent: recentTelemetry.slice(-50),
          schedule,
        },
      })
    );
    console.log(`[WS] Dashboard ket noi (role=${claims.role})`);
  }

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (socket.role === 'device') {
      onTelemetry(socket, message);
    } else if (message.cmd) {
      onDashboardCommand(socket, message);
    } else if (message.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
    }
  });

  socket.on('close', () => {
    deviceSockets.delete(socket);
    dashboardSockets.delete(socket);
    console.log(`[WS] ${socket.role} ngat ket noi`);
    broadcastDeviceStatus();
  });

  socket.on('error', (error) => {
    console.error('[WS] Socket error:', error.message);
  });
});

// Heartbeat: dọn client chết (ESP32 trả lời PING tự động).
const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeatTimer));

// ------------------------------------------------------------
// Khởi động
// ------------------------------------------------------------
server.listen(PORT, () => {
  console.log('==============================================');
  console.log(`  Pet Feeder Gateway - http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`  Dashboard: http://localhost:${PORT}/index.html`);
  console.log(`  Supabase : ${SUPABASE_URL ? 'ON' : 'OFF (in-memory)'}`);
  if (JWT_SECRET) {
    console.log('  JWT      : ON (RBAC admin/owner/viewer)');
    console.log('  Demo tokens (hết hạn sau 12h):');
    for (const role of ['admin', 'owner', 'viewer']) {
      console.log(`    ${role.padEnd(7)}: ${signToken({ role, sub: `${role}-demo` }, 43200)}`);
    }
  } else {
    console.log('  JWT      : OFF (demo mode - mọi dashboard là admin)');
  }
  console.log('==============================================');
});

process.on('SIGINT', () => {
  console.log('\nĐang tắt gateway...');
  server.close(() => process.exit(0));
});
