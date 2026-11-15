/**
 * [SV2 + SV3] WebSocket Gateway (100% Firebase + in-memory demo fallback)
 *  - Nhận telemetry Compact JSON từ ESP32 (qua WebSocket)
 *  - Gửi ACK {"ack": seq} để ESP32 pop Ring Buffer
 *  - Nhận xác nhận lệnh {"cack": cid, "ok": true} (T-SV2-01)
 *  - Broadcast realtime (telemetry, status, schedule, alert) lên Mobile App & Dashboard
 *  - Đồng bộ telemetry, devices, alerts, feeding_events, schedules, stats lên Cloud Firestore
 *  - Xác thực JWT Firebase Auth + RBAC (auth.js) & Push Notification FCM (notify.js)
 */
'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { initFirebase } = require('./firebase');
const { createAuthHelpers } = require('./auth');
const { createAlertEngine } = require('./alerts');
const { createNotifier } = require('./notify');

const PORT = Number(process.env.PORT || 8080);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const firebase = initFirebase();
const { isFirebaseEnabled, admin: firebaseAdmin, db: firestoreDb, auth: firebaseAuth, messaging } =
  firebase;

const authHelpers = createAuthHelpers({
  firebaseAuth,
  firestoreDb,
});
const { signToken, verifyTokenAsync, deviceAuthorized, auth, hasAuthConfigured } = authHelpers;

const notifier = createNotifier({ firestoreDb, messaging });

// ------------------------------------------------------------
// Trạng thái in-memory (fallback khi chưa cấu hình Firebase)
// ------------------------------------------------------------
const deviceSockets = new Set();
const dashboardSockets = new Set();
const recentTelemetry = [];
const recentAlerts = [];
const recentFeedingEvents = [];
const pendingCommands = new Map(); // cid -> { id, device_id, command, payload, created_at, acked }
const lastWeightByDevice = new Map(); // phục vụ tính eaten_g cho stats_hourly / stats_daily
const lastSeenMsByDevice = new Map();
const seenPackets = new Set();
const MAX_RECENT = 500;
const MAX_SEEN = 5000;
const OFFLINE_STALE_MS = 120_000;
let nextCommandId = 1;

const schedulesByDevice = new Map();
function getDeviceSchedules(deviceId = 'esp01') {
  if (!schedulesByDevice.has(deviceId)) {
    schedulesByDevice.set(deviceId, [{ hour: 8, minute: 0, grams: 30, enabled: false }]);
  }
  return schedulesByDevice.get(deviceId);
}

// ------------------------------------------------------------
// Alert Engine & Feeding Events (SV2: T-SV2-03)
// ------------------------------------------------------------
const alertEngine = createAlertEngine({
  onAlert(alert) {
    recentAlerts.unshift(alert);
    if (recentAlerts.length > 200) recentAlerts.pop();
    broadcast({ type: 'alert', data: alert });
    persistAlert(alert);
    notifier.sendAlertPush(alert).catch((err) => {
      console.error('[FCM] Lỗi gửi push:', err.message);
    });
  },
  onFeedingEvent(event) {
    recentFeedingEvents.unshift(event);
    if (recentFeedingEvents.length > 200) recentFeedingEvents.pop();
    persistFeedingEvent(event);
  },
});

// ------------------------------------------------------------
// Express REST API
// ------------------------------------------------------------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});
app.use(express.static(path.join(__dirname, '..', 'dashboard-app')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    devices: deviceSnapshot(),
    dashboards: dashboardSockets.size,
    buffered_records: recentTelemetry.length,
    firebase: isFirebaseEnabled,
    fcm_mode: notifier.mode,
  });
});

// TODO(T-SV3-03/T-SV3-05): Khi bật Firebase Auth, lọc thiết bị theo owner_id / member_ids của req.user.sub
app.get('/api/devices', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const connectedMap = new Map(deviceSnapshot().map((d) => [d.id, d]));
  if (firestoreDb) {
    try {
      const snap = await firestoreDb.collection('devices').orderBy('id', 'asc').get();
      const rows = snap.docs.map((doc) => {
        const row = doc.data() || {};
        const id = row.id || doc.id;
        return {
          ...row,
          id,
          online: connectedMap.has(id) ? true : Boolean(row.online),
        };
      });
      if (rows.length > 0) {
        return res.json({ data: rows });
      }
    } catch (error) {
      console.error('[API] /api/devices lỗi:', error.message);
    }
  }

  const latestByDevice = new Map();
  for (const r of recentTelemetry) {
    latestByDevice.set(r.device_id, r);
  }
  const ids = new Set(['esp01', ...connectedMap.keys(), ...latestByDevice.keys()]);
  const data = [...ids].map((id) => {
    const latest = latestByDevice.get(id);
    return {
      id,
      name: `Pet Feeder - ${id}`,
      online: connectedMap.has(id),
      last_seen: latest?.recorded_at || null,
      portion_grams: 30,
      bowl_weight_g: latest?.weight_g ?? 0,
      food_level: latest?.food_level ?? 0,
    };
  });
  return res.json({ data });
});

app.get('/api/telemetry', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || '');
  const limit = Math.min(Number(req.query.limit) || 100, MAX_RECENT);
  const from = req.query.from ? String(req.query.from) : '';
  const to = req.query.to ? String(req.query.to) : '';

  if (firestoreDb) {
    try {
      let query = firestoreDb.collection('telemetry_logs');
      if (deviceId) query = query.where('device_id', '==', deviceId);
      if (from) query = query.where('recorded_at', '>=', from);
      if (to) query = query.where('recorded_at', '<=', to);
      const snap = await query.orderBy('recorded_at', 'desc').limit(limit).get();
      const rows = snap.docs.map((doc) => doc.data()).reverse();
      return res.json({ data: rows });
    } catch (error) {
      console.error('[API] /api/telemetry lỗi:', error.message);
    }
  }

  let list = recentTelemetry;
  if (deviceId) list = list.filter((r) => r.device_id === deviceId);
  if (from) list = list.filter((r) => r.recorded_at >= from);
  if (to) list = list.filter((r) => r.recorded_at <= to);
  return res.json({ data: list.slice(-limit) });
});

// [SV3: T-SV3-05] Thống kê tiêu thụ theo giờ (24h) hoặc ngày (7d, 30d)
app.get('/api/stats', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || 'esp01');
  const range = String(req.query.range || '24h');
  const isHourly = range === '24h';
  const collectionName = isHourly ? 'stats_hourly' : 'stats_daily';
  const days = range === '30d' ? 30 : range === '7d' ? 7 : 1;
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  if (firestoreDb) {
    try {
      const snap = await firestoreDb
        .collection(collectionName)
        .where('device_id', '==', deviceId)
        .where('bucket', '>=', since)
        .orderBy('bucket', 'asc')
        .get();
      const rows = snap.docs.map((doc) => doc.data());
      return res.json({ range, device_id: deviceId, data: rows });
    } catch (error) {
      console.error('[API] /api/stats lỗi:', error.message);
    }
  }

  const buckets = new Map();
  let prevWeight = null;
  for (const r of recentTelemetry) {
    if (r.device_id !== deviceId || r.recorded_at < since) continue;
    if (prevWeight !== null && r.status !== 1 && r.weight_g < prevWeight - 0.5) {
      const d = new Date(r.recorded_at);
      const bucketKey = isHourly
        ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).toISOString()
        : new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
      buckets.set(
        bucketKey,
        +(Number(buckets.get(bucketKey) || 0) + (prevWeight - r.weight_g)).toFixed(1)
      );
    }
    prevWeight = r.weight_g;
  }
  const data = [...buckets.entries()].map(([bucket, eaten_g]) => ({
    device_id: deviceId,
    bucket,
    eaten_g,
  }));
  return res.json({ range, device_id: deviceId, data });
});

app.get('/api/schedule', auth(['admin', 'owner', 'viewer']), (req, res) => {
  const deviceId = String(req.query.device || 'esp01');
  const list = getDeviceSchedules(deviceId);
  res.json({ data: list[0] || { enabled: false, hour: 8, minute: 0, grams: 30 } });
});

app.get('/api/schedules', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || 'esp01');
  if (firestoreDb) {
    try {
      const snap = await firestoreDb
        .collection('feeding_schedules')
        .where('device_id', '==', deviceId)
        .orderBy('hour', 'asc')
        .orderBy('minute', 'asc')
        .get();
      const rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      return res.json({ data: rows });
    } catch (error) {
      console.error('[API] /api/schedules lỗi:', error.message);
    }
  }
  return res.json({ data: getDeviceSchedules(deviceId) });
});

function enqueueCommand(deviceId, commandName, payload) {
  const cid = nextCommandId++;
  const entry = {
    cid,
    device_id: deviceId,
    command: commandName,
    payload,
    attempts: 1,
    acked: false,
    created_at: new Date().toISOString(),
    delivered_at: null,
  };
  pendingCommands.set(cid, entry);
  if (firestoreDb) {
    firestoreDb
      .collection('device_commands')
      .doc(String(cid))
      .set(entry)
      .catch((err) => console.error('[FIRESTORE:device_commands]', err.message));
  }
  return entry;
}

app.post('/api/feed', auth(['admin', 'owner']), (req, res) => {
  const deviceId = String(req.body?.device || 'esp01');
  const grams = Math.max(1, Math.min(200, Number(req.body?.grams) || 30));
  const cmdEntry = enqueueCommand(deviceId, 'FEED', { g: grams });
  const sent = sendToDevices({ cmd: 'FEED', g: grams, cid: cmdEntry.cid }, deviceId);
  console.log(`[CMD] FEED ${grams}g cid=${cmdEntry.cid} (${deviceId}) -> ${sent} thiet bi`);
  res.json({ ok: sent > 0, sent, grams, cid: cmdEntry.cid });
});

app.post('/api/stop', auth(['admin', 'owner']), (req, res) => {
  const deviceId = String(req.body?.device || 'esp01');
  const cmdEntry = enqueueCommand(deviceId, 'STOP', {});
  const sent = sendToDevices({ cmd: 'STOP', cid: cmdEntry.cid }, deviceId);
  console.log(`[CMD] STOP cid=${cmdEntry.cid} (${deviceId}) -> ${sent} thiet bi`);
  res.json({ ok: sent > 0, sent, cid: cmdEntry.cid });
});

// Tương thích ngược với dashboard-app hiện tại (1 lịch đơn)
app.post('/api/schedule', auth(['admin', 'owner']), (req, res) => {
  const deviceId = String(req.body?.device || 'esp01');
  const body = req.body || {};
  const single = {
    enabled: Boolean(body.enabled),
    hour: Math.max(0, Math.min(23, Number(body.hour) || 0)),
    minute: Math.max(0, Math.min(59, Number(body.minute) || 0)),
    grams: Math.max(1, Math.min(200, Number(body.grams) || 30)),
  };
  schedulesByDevice.set(deviceId, [single]);
  persistSchedulesToFirestore(deviceId, [single]);
  const cmdEntry = enqueueCommand(deviceId, 'SET_SCHEDULE', single);
  const sent = sendToDevices(
    {
      cmd: 'SET_SCHEDULE',
      cid: cmdEntry.cid,
      h: single.hour,
      m: single.minute,
      g: single.grams,
      on: single.enabled,
    },
    deviceId
  );
  broadcast({ type: 'schedule', data: single });
  console.log(
    `[CMD] SCHEDULE ${single.enabled ? 'ON' : 'OFF'} ` +
      `${String(single.hour).padStart(2, '0')}:${String(single.minute).padStart(2, '0')} ` +
      `${single.grams}g -> ${sent} thiet bi`
  );
  res.json({ ok: true, sent, schedule: single, cid: cmdEntry.cid });
});

// API cho Flutter App: quản lý tối đa 4 lịch trên thiết bị
app.put('/api/schedules', auth(['admin', 'owner']), async (req, res) => {
  const deviceId = String(req.body?.device || 'esp01');
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = rawItems.slice(0, 4).map((item) => ({
    hour: Math.max(0, Math.min(23, Number(item.hour ?? item.h) || 0)),
    minute: Math.max(0, Math.min(59, Number(item.minute ?? item.m) || 0)),
    grams: Math.max(1, Math.min(200, Number(item.grams ?? item.g) || 30)),
    enabled: Boolean(item.enabled ?? item.on ?? true),
  }));
  schedulesByDevice.set(deviceId, items);
  await persistSchedulesToFirestore(deviceId, items);

  const cmdEntry = enqueueCommand(deviceId, 'SET_SCHEDULES', { items });
  const sent = sendToDevices(
    {
      cmd: 'SET_SCHEDULES',
      cid: cmdEntry.cid,
      items: items.map((s) => ({ h: s.hour, m: s.minute, g: s.grams, on: s.enabled })),
    },
    deviceId
  );
  if (items[0]) {
    broadcast({ type: 'schedule', data: items[0] });
  }
  res.json({ ok: true, sent, items, cid: cmdEntry.cid });
});

app.get('/api/alerts', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || '');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  if (firestoreDb) {
    try {
      let query = firestoreDb.collection('alerts');
      if (deviceId) query = query.where('device_id', '==', deviceId);
      const snap = await query.orderBy('created_at', 'desc').limit(limit).get();
      return res.json({
        data: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      });
    } catch (error) {
      console.error('[API] /api/alerts lỗi:', error.message);
    }
  }
  const filtered = deviceId
    ? recentAlerts.filter((a) => a.device_id === deviceId)
    : recentAlerts;
  return res.json({ data: filtered.slice(0, limit) });
});

app.post('/api/fcm-token', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const platform = String(req.body?.platform || 'android').toLowerCase();
  if (!token || !['android', 'ios', 'web'].includes(platform)) {
    return res.status(400).json({ error: 'invalid token or platform' });
  }
  const result = await notifier.upsertFcmToken({
    userId: req.user.sub,
    token,
    platform,
  });
  return res.json(result);
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

function sendToDevices(command, targetDeviceId = '') {
  const data = JSON.stringify(command);
  let sent = 0;
  for (const device of deviceSockets) {
    if (device.readyState !== WebSocket.OPEN) continue;
    if (targetDeviceId && device.deviceId && device.deviceId !== targetDeviceId) {
      continue;
    }
    device.send(data);
    sent++;
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

function onTelemetry(socket, message) {
  if (message.hello) {
    socket.deviceId = String(message.hello);
    lastSeenMsByDevice.set(socket.deviceId, Date.now());
    console.log(`[WS] Thiet bi ${socket.deviceId} dang ky`);
    alertEngine.markOnline(socket.deviceId);
    updateDeviceOnline(socket.deviceId, true);
    broadcastDeviceStatus();
    // TODO(T-SV2-01): Đẩy lại các lệnh chưa ack (acked == false) và SET_SCHEDULES xuống thiết bị.
    return;
  }

  if (message.cack !== undefined) {
    const cid = Number(message.cack);
    const cmd = pendingCommands.get(cid);
    if (cmd) {
      cmd.acked = true;
      cmd.delivered_at = new Date().toISOString();
    }
    if (firestoreDb && Number.isFinite(cid)) {
      firestoreDb
        .collection('device_commands')
        .doc(String(cid))
        .set(
          { acked: true, delivered_at: new Date().toISOString() },
          { merge: true }
        )
        .catch(() => {});
    }
    console.log(`[CMD] ACK cid=${cid} ok=${Boolean(message.ok)}`);
    return;
  }

  const seq = Number(message.s);
  const deviceId = String(message.id || socket.deviceId || 'unknown');
  if (!Number.isFinite(seq)) {
    console.warn('[WS] Goi tin khong hop le:', message);
    return;
  }
  socket.deviceId = deviceId;
  lastSeenMsByDevice.set(deviceId, Date.now());

  // ACK ngay để ESP32 pop() Ring Buffer (kể cả gói trùng do timeout ACK).
  socket.send(JSON.stringify({ ack: seq }));

  if (!rememberPacket(`${deviceId}:${seq}`)) {
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

  alertEngine.processTelemetry(record);
  broadcast({ type: 'telemetry', data: record });
  persistTelemetry(record);
}

// ------------------------------------------------------------
// Cloud Firestore Persistence (100% Firebase Spark)
// ------------------------------------------------------------
async function persistTelemetry(record) {
  if (!firestoreDb) return false;
  try {
    // ID tất định ${device_id}_${seq_num} tự chống ghi trùng khi ESP32 sync lại.
    const docId = `${record.device_id}_${record.seq_num}`;
    await firestoreDb.collection('telemetry_logs').doc(docId).set({
      device_id: record.device_id,
      seq_num: record.seq_num,
      recorded_at: record.recorded_at,
      weight_g: record.weight_g,
      food_level: record.food_level,
      status: record.status,
      error_code: record.error_code,
      synced: record.synced,
      raw: record.raw,
    });

    await firestoreDb.collection('devices').doc(record.device_id).set(
      {
        id: record.device_id,
        online: true,
        last_seen: record.recorded_at,
        bowl_weight_g: record.weight_g,
        food_level: record.food_level,
      },
      { merge: true }
    );

    const prevWeight = lastWeightByDevice.get(record.device_id);
    lastWeightByDevice.set(record.device_id, record.weight_g);
    if (prevWeight !== undefined && record.status !== 1 && record.weight_g < prevWeight - 0.5) {
      const eatenDelta = +(prevWeight - record.weight_g).toFixed(1);
      await incrementConsumptionStats(record.device_id, record.recorded_at, eatenDelta);
    }
    return true;
  } catch (error) {
    console.error('[FIRESTORE:telemetry_logs]', error.message);
    return false;
  }
}

async function incrementConsumptionStats(deviceId, recordedAtIso, eatenDelta) {
  if (!firestoreDb || !firebaseAdmin) return;
  const inc = firebaseAdmin.firestore.FieldValue.increment(eatenDelta);
  const d = new Date(recordedAtIso);
  const vnTime = new Date(d.getTime() + 7 * 3600 * 1000);
  const y = vnTime.getUTCFullYear();
  const mo = String(vnTime.getUTCMonth() + 1).padStart(2, '0');
  const da = String(vnTime.getUTCDate()).padStart(2, '0');
  const ho = String(vnTime.getUTCHours()).padStart(2, '0');

  const hourBucket = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString();
  const dayBucket = `${y}-${mo}-${da}T00:00:00.000+07:00`;

  await Promise.all([
    firestoreDb
      .collection('stats_hourly')
      .doc(`${deviceId}_${y}${mo}${da}${ho}`)
      .set({ device_id: deviceId, bucket: hourBucket, eaten_g: inc }, { merge: true }),
    firestoreDb
      .collection('stats_daily')
      .doc(`${deviceId}_${y}${mo}${da}`)
      .set({ device_id: deviceId, bucket: dayBucket, eaten_g: inc }, { merge: true }),
  ]);
}

async function persistSchedulesToFirestore(deviceId, items) {
  if (!firestoreDb) return;
  try {
    const existing = await firestoreDb
      .collection('feeding_schedules')
      .where('device_id', '==', deviceId)
      .get();
    const batch = firestoreDb.batch();
    existing.docs.forEach((doc) => batch.delete(doc.ref));
    items.forEach((item, idx) => {
      const ref = firestoreDb.collection('feeding_schedules').doc(`${deviceId}_${idx}`);
      batch.set(ref, {
        device_id: deviceId,
        hour: item.hour,
        minute: item.minute,
        grams: item.grams,
        enabled: item.enabled,
        updated_at: new Date().toISOString(),
      });
    });
    await batch.commit();
  } catch (error) {
    console.error('[FIRESTORE:feeding_schedules]', error.message);
  }
}

function persistAlert(alert) {
  if (!firestoreDb) return Promise.resolve(false);
  return firestoreDb
    .collection('alerts')
    .add({
      device_id: alert.device_id,
      kind: alert.kind,
      message: alert.message,
      created_at: alert.created_at,
      pushed: alert.pushed,
      read_at: null,
    })
    .then(() => true)
    .catch((err) => {
      console.error('[FIRESTORE:alerts]', err.message);
      return false;
    });
}

function persistFeedingEvent(event) {
  if (!firestoreDb) return Promise.resolve(false);
  return firestoreDb
    .collection('feeding_events')
    .add(event)
    .then(() => true)
    .catch((err) => {
      console.error('[FIRESTORE:feeding_events]', err.message);
      return false;
    });
}

async function updateDeviceOnline(deviceId, online) {
  if (!firestoreDb || !deviceId) return;
  try {
    await firestoreDb.collection('devices').doc(deviceId).set(
      {
        id: deviceId,
        online,
        ...(online ? { last_seen: new Date().toISOString() } : {}),
      },
      { merge: true }
    );
  } catch (error) {
    console.error('[FIRESTORE:devices]', error.message);
  }
}

// Quét thiết bị mất kết nối mỗi 60s (thay thế Cloud Functions / pg_cron để chạy 100% Spark miễn phí)
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, lastSeenMs] of lastSeenMsByDevice.entries()) {
    const connected = [...deviceSockets].some(
      (s) => s.deviceId === deviceId && s.readyState === WebSocket.OPEN
    );
    if (!connected && now - lastSeenMs > OFFLINE_STALE_MS) {
      updateDeviceOnline(deviceId, false);
      alertEngine.markOffline(deviceId);
    }
  }
}, 60_000).unref();

function onDashboardCommand(socket, message) {
  const role = socket.user?.role || 'viewer';
  if (!['admin', 'owner'].includes(role)) {
    socket.send(JSON.stringify({ type: 'error', error: 'forbidden' }));
    return;
  }
  const deviceId = String(message.device || 'esp01');
  const cmd = String(message.cmd || '').toUpperCase();
  if (cmd === 'FEED') {
    const cmdEntry = enqueueCommand(deviceId, 'FEED', { g: Number(message.g) || 30 });
    sendToDevices({ cmd: 'FEED', g: Number(message.g) || 30, cid: cmdEntry.cid }, deviceId);
  } else if (cmd === 'STOP') {
    const cmdEntry = enqueueCommand(deviceId, 'STOP', {});
    sendToDevices({ cmd: 'STOP', cid: cmdEntry.cid }, deviceId);
  } else if (cmd === 'CLEAR_ERROR') {
    const cmdEntry = enqueueCommand(deviceId, 'CLEAR_ERROR', {});
    sendToDevices({ cmd: 'CLEAR_ERROR', cid: cmdEntry.cid }, deviceId);
  } else {
    socket.send(JSON.stringify({ type: 'error', error: 'unknown command' }));
  }
}

wss.on('connection', async (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const role = url.searchParams.get('role') || 'dashboard';
  const token = url.searchParams.get('token') || '';

  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  if (role === 'device') {
    if (!deviceAuthorized(request, token)) {
      console.warn('[WS] Tu choi thiet bi: sai DEVICE_TOKEN');
      socket.close(4001, 'invalid device token');
      return;
    }
    socket.role = 'device';
    deviceSockets.add(socket);
    console.log('[WS] Thiet bi ket noi');
    broadcastDeviceStatus();
  } else {
    const claims = await verifyTokenAsync(token);
    if (!claims) {
      socket.close(4001, 'invalid token');
      return;
    }
    socket.role = 'dashboard';
    socket.user = claims;
    dashboardSockets.add(socket);
    const defaultSchedules = getDeviceSchedules('esp01');
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        data: {
          devices: deviceSnapshot(),
          recent: recentTelemetry.slice(-50),
          schedule: defaultSchedules[0] || { enabled: false, hour: 8, minute: 0, grams: 30 },
          schedules: defaultSchedules,
          alerts: recentAlerts.slice(0, 20),
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
    if (socket.role === 'device' && socket.deviceId) {
      const stillConnected = [...deviceSockets].some(
        (d) => d.deviceId === socket.deviceId && d.readyState === WebSocket.OPEN
      );
      if (!stillConnected) {
        updateDeviceOnline(socket.deviceId, false);
        // TODO(T-SV2-02): Đợi 60s trước khi gửi cảnh báo OFFLINE để tránh báo giả khi rớt mạng thoáng qua.
        alertEngine.markOffline(socket.deviceId);
      }
    }
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
  console.log(`  Firebase : ${isFirebaseEnabled ? 'ON (Firestore + Auth)' : 'OFF (in-memory)'}`);
  console.log(`  FCM      : ${notifier.mode === 'fcm' ? 'ON' : 'DEMO (log only)'}`);
  if (hasAuthConfigured) {
    console.log('  JWT      : ON (RBAC admin/owner/viewer)');
    if (process.env.JWT_SECRET) {
      console.log('  Demo tokens (hết hạn sau 12h):');
      for (const role of ['admin', 'owner', 'viewer']) {
        console.log(`    ${role.padEnd(7)}: ${signToken({ role, sub: `${role}-demo` }, 43200)}`);
      }
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
