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
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { initFirebase } = require('./firebase');
const { createAuthHelpers } = require('./auth');
const { createAlertEngine } = require('./alerts');
const { createNotifier } = require('./notify');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
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
const lastSeenMsByDevice = new Map();
const knownDevices = new Map(); // device_id -> last persisted device fields
const seenPackets = new Set();
const MAX_RECENT = 500;
const MAX_SEEN = 5000;
const OFFLINE_STALE_MS = 60_000;
const TELEMETRY_SPOOL_PATH = path.resolve(
  __dirname,
  process.env.TELEMETRY_SPOOL_PATH || './telemetry-spool.jsonl'
);
let spoolFlushInProgress = false;
let nextCommandId = crypto.randomInt(1, 0x100000000);
const offlineTimers = new Map();

const schedulesByDevice = new Map();
function getDeviceSchedules(deviceId = 'esp01') {
  if (!schedulesByDevice.has(deviceId)) {
    schedulesByDevice.set(deviceId, [{ hour: 8, minute: 0, grams: 30, enabled: false }]);
  }
  return schedulesByDevice.get(deviceId);
}

function rememberDevice(deviceId, fields = {}) {
  if (!deviceId) return;
  knownDevices.set(deviceId, {
    ...(knownDevices.get(deviceId) || {}),
    ...fields,
    id: deviceId,
  });
}

function canAccessDeviceRecord(user, device) {
  if (user?.role === 'admin') return true;
  const uid = String(user?.uid || user?.sub || '');
  if (!uid || !device) return false;
  if (user.role === 'owner') return String(device.owner_id || '') === uid;
  if (user.role === 'viewer') {
    return Array.isArray(device.member_ids) && device.member_ids.includes(uid);
  }
  return false;
}

async function userCanAccessDevice(user, deviceId) {
  if (user?.role === 'admin') return true;
  if (!firestoreDb || !deviceId || String(deviceId).includes('/')) return false;
  try {
    const snap = await firestoreDb.collection('devices').doc(String(deviceId)).get();
    return snap.exists && canAccessDeviceRecord(user, snap.data());
  } catch (error) {
    console.error('[AUTH:device-access]', error.message);
    return false;
  }
}

function timestampMillis(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().getTime();
  return Date.parse(value);
}

async function requireDeviceAccess(req, res, deviceId) {
  if (await userCanAccessDevice(req.user, deviceId)) return true;
  res.status(403).json({ error: 'device_forbidden' });
  return false;
}

async function getAccessibleDeviceIds(user) {
  if (user?.role === 'admin') return null;
  if (!firestoreDb) return [];
  try {
    const uid = String(user?.uid || user?.sub || '');
    if (!uid) return [];
    const query = user?.role === 'owner'
      ? firestoreDb.collection('devices').where('owner_id', '==', uid)
      : firestoreDb.collection('devices').where('member_ids', 'array-contains', uid);
    const snap = await query.get();
    return snap.docs.map((doc) => String(doc.data()?.id || doc.id));
  } catch (error) {
    console.error('[AUTH:device-access]', error.message);
    return [];
  }
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
    devices_online: deviceSnapshot().filter((device) => device.online).length,
    dashboards: dashboardSockets.size,
    buffered_records: recentTelemetry.length,
    firebase: isFirebaseEnabled,
    fcm_mode: notifier.mode,
  });
});

app.get('/api/devices', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const connectedMap = new Map(deviceSnapshot().map((d) => [d.id, d]));
  if (firestoreDb) {
    try {
      const devices = firestoreDb.collection('devices');
      const uid = String(req.user?.uid || req.user?.sub || '');
      const query = req.user?.role === 'admin'
        ? devices.orderBy('id', 'asc')
        : req.user?.role === 'owner'
          ? devices.where('owner_id', '==', uid)
          : devices.where('member_ids', 'array-contains', uid);
      const snap = await query.get();
      const rows = snap.docs.map((doc) => {
        const row = doc.data() || {};
        const id = row.id || doc.id;
        return {
          ...row,
          id,
          online: connectedMap.has(id) ? Boolean(connectedMap.get(id).online) : Boolean(row.online),
        };
      }).sort((a, b) => a.id.localeCompare(b.id));
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
  }).filter((device) => req.user?.role === 'admin' && !firestoreDb);
  return res.json({ data });
});

app.get('/api/telemetry', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || '');
  const limit = Math.min(Number(req.query.limit) || 100, MAX_RECENT);
  const from = req.query.from ? String(req.query.from) : '';
  const to = req.query.to ? String(req.query.to) : '';
  if (deviceId && !(await requireDeviceAccess(req, res, deviceId))) return;
  const accessibleIds = deviceId ? [deviceId] : await getAccessibleDeviceIds(req.user);
  if (accessibleIds && accessibleIds.length === 0) return res.json({ data: [] });

  if (firestoreDb) {
    try {
      let query = firestoreDb.collection('telemetry_logs');
      if (deviceId || accessibleIds?.length === 1) query = query.where('device_id', '==', deviceId || accessibleIds[0]);
      else if (accessibleIds) query = query.where('device_id', 'in', accessibleIds.slice(0, 30));
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
  if (accessibleIds) list = list.filter((r) => accessibleIds.includes(r.device_id));
  if (from) list = list.filter((r) => r.recorded_at >= from);
  if (to) list = list.filter((r) => r.recorded_at <= to);
  return res.json({ data: list.slice(-limit) });
});

// [SV3: T-SV3-05] Thống kê tiêu thụ theo giờ (24h) hoặc ngày (7d, 30d)
app.get('/api/stats', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || 'esp01');
  if (!(await requireDeviceAccess(req, res, deviceId))) return;
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

app.get('/api/schedule', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || 'esp01');
  if (!(await requireDeviceAccess(req, res, deviceId))) return;
  const list = getDeviceSchedules(deviceId);
  res.json({ data: list[0] || { enabled: false, hour: 8, minute: 0, grams: 30 } });
});

app.get('/api/schedules', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || 'esp01');
  if (!(await requireDeviceAccess(req, res, deviceId))) return;
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
  let cid = nextCommandId;
  do {
    nextCommandId = (nextCommandId + 1) >>> 0;
    if (nextCommandId === 0) nextCommandId = 1;
    if (!pendingCommands.has(cid)) break;
    cid = nextCommandId;
  } while (true);
  const entry = {
    cid,
    device_id: deviceId,
    command: commandName,
    payload,
    attempts: 0,
    acked: false,
    created_at: new Date().toISOString(),
    delivered_at: null,
  };
  pendingCommands.set(cid, entry);
  return entry;
}

async function persistCommand(entry) {
  if (!firestoreDb) return true;
  try {
    await firestoreDb.collection('device_commands').doc(String(entry.cid)).set(entry);
    return true;
  } catch (err) {
    console.error('[FIRESTORE:device_commands] write:', err.message);
    return false;
  }
}

async function saveCommandOrRespond(entry, res) {
  if (await persistCommand(entry)) return true;
  pendingCommands.delete(entry.cid);
  res.status(503).json({ error: 'command_queue_unavailable' });
  return false;
}

function wireCommand(entry) {
  const payload = entry.payload || {};
  if (entry.command === 'FEED') return { cmd: 'FEED', g: payload.g, cid: entry.cid };
  if (entry.command === 'STOP') return { cmd: 'STOP', cid: entry.cid };
  if (entry.command === 'CLEAR_ERROR') return { cmd: 'CLEAR_ERROR', cid: entry.cid };
  if (entry.command === 'SET_SCHEDULE') {
    return { cmd: 'SET_SCHEDULE', h: payload.hour, m: payload.minute,
      g: payload.grams, on: payload.enabled, cid: entry.cid };
  }
  if (entry.command === 'SET_SCHEDULES') {
    return { cmd: 'SET_SCHEDULES', cid: entry.cid,
      items: (payload.items || []).map((s) => ({ h: s.hour, m: s.minute, g: s.grams, on: s.enabled })) };
  }
  return null;
}

async function deliverCommand(entry, socket) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const expired = entry.command === 'FEED' && Date.now() - Date.parse(entry.created_at) > 10 * 60_000;
  if (expired) {
    entry.payload = { ...(entry.payload || {}), expired: true };
    entry.expired = true;
    if (firestoreDb) await firestoreDb.collection('device_commands').doc(String(entry.cid))
      .set({ payload: entry.payload, expired: true, delivered_at: null }, { merge: true });
    return false;
  }
  const payload = wireCommand(entry);
  if (!payload) return false;
  socket.send(JSON.stringify(payload));
  entry.attempts = (entry.attempts || 0) + 1;
  entry.last_sent_at = new Date().toISOString();
  if (firestoreDb) await firestoreDb.collection('device_commands').doc(String(entry.cid))
    .set({ attempts: entry.attempts, last_sent_at: entry.last_sent_at }, { merge: true });
  return true;
}

async function dispatchCommand(entry) {
  const targets = [...deviceSockets].filter((socket) =>
    socket.deviceId === entry.device_id && socket.readyState === WebSocket.OPEN
  );
  let sent = 0;
  for (const socket of targets) {
    if (await deliverCommand(entry, socket)) sent++;
  }
  return sent;
}

async function flushDeviceCommands(deviceId, socket) {
  let entries = [...pendingCommands.values()].filter((entry) =>
    entry.device_id === deviceId && !entry.acked && !entry.expired
  );
  if (firestoreDb) {
    try {
      const snap = await firestoreDb.collection('device_commands').where('device_id', '==', deviceId)
        .where('acked', '==', false).orderBy('created_at', 'asc').get();
      entries = snap.docs.map((doc) => ({ ...doc.data(), cid: Number(doc.data().cid || doc.id) }))
        .filter((entry) => !entry.delivered_at && !entry.expired);
      for (const entry of entries) pendingCommands.set(entry.cid, entry);
    } catch (err) {
      console.error('[FIRESTORE:device_commands] pending read:', err.message);
    }
  }
  if (!firestoreDb) entries.sort((a, b) => Number(a.cid) - Number(b.cid));
  for (const entry of entries) await deliverCommand(entry, socket);

  // Schedule snapshot follows the command queue so the device ends with the current cloud state.
  let schedules = getDeviceSchedules(deviceId);
  let schedulesAvailable = !firestoreDb;
  if (firestoreDb) {
    try {
      const snap = await firestoreDb.collection('feeding_schedules').where('device_id', '==', deviceId)
        .orderBy('hour', 'asc').orderBy('minute', 'asc').get();
      schedules = snap.docs.map((doc) => doc.data());
      schedulesByDevice.set(deviceId, schedules);
      schedulesAvailable = true;
    } catch (err) {
      console.error('[FIRESTORE:feeding_schedules] sync read:', err.message);
    }
  }
  if (schedulesAvailable) {
    socket.send(JSON.stringify({ cmd: 'SET_SCHEDULES', cid: 0,
      items: schedules.slice(0, 4).map((s) => ({ h: s.hour, m: s.minute, g: s.grams, on: s.enabled })) }));
  }
}

setInterval(() => {
  const now = Date.now();
  for (const entry of pendingCommands.values()) {
    if (entry.acked || entry.expired || !entry.last_sent_at || (entry.attempts || 0) >= 3) continue;
    if (now - Date.parse(entry.last_sent_at) < 10_000) continue;
    dispatchCommand(entry).catch((err) => console.error('[CMD] Retry error:', err.message));
  }
}, 1000).unref();

app.post('/api/feed', auth(['admin', 'owner']), async (req, res) => {
  const deviceId = String(req.body?.device || 'esp01');
  if (!(await requireDeviceAccess(req, res, deviceId))) return;
  const grams = Math.max(1, Math.min(200, Number(req.body?.grams) || 30));
  const cmdEntry = enqueueCommand(deviceId, 'FEED', { g: grams });
  if (!(await saveCommandOrRespond(cmdEntry, res))) return;
  const sent = await dispatchCommand(cmdEntry);
  console.log(`[CMD] FEED ${grams}g cid=${cmdEntry.cid} (${deviceId}) -> ${sent} thiet bi`);
  res.json({ ok: sent > 0, sent, grams, cid: cmdEntry.cid });
});

app.post('/api/stop', auth(['admin', 'owner']), async (req, res) => {
  const deviceId = String(req.body?.device || 'esp01');
  if (!(await requireDeviceAccess(req, res, deviceId))) return;
  const cmdEntry = enqueueCommand(deviceId, 'STOP', {});
  if (!(await saveCommandOrRespond(cmdEntry, res))) return;
  const sent = await dispatchCommand(cmdEntry);
  console.log(`[CMD] STOP cid=${cmdEntry.cid} (${deviceId}) -> ${sent} thiet bi`);
  res.json({ ok: sent > 0, sent, cid: cmdEntry.cid });
});

// Tương thích ngược với dashboard-app hiện tại (1 lịch đơn)
app.post('/api/schedule', auth(['admin', 'owner']), async (req, res) => {
  const deviceId = String(req.body?.device || 'esp01');
  if (!(await requireDeviceAccess(req, res, deviceId))) return;
  const body = req.body || {};
  const single = {
    enabled: Boolean(body.enabled),
    hour: Math.max(0, Math.min(23, Number(body.hour) || 0)),
    minute: Math.max(0, Math.min(59, Number(body.minute) || 0)),
    grams: Math.max(1, Math.min(200, Number(body.grams) || 30)),
  };
  if (!(await persistSchedulesToFirestore(deviceId, [single]))) {
    return res.status(503).json({ error: 'schedule_store_unavailable' });
  }
  schedulesByDevice.set(deviceId, [single]);
  const cmdEntry = enqueueCommand(deviceId, 'SET_SCHEDULE', single);
  if (!(await saveCommandOrRespond(cmdEntry, res))) return;
  const sent = await dispatchCommand(cmdEntry);
  broadcast({ type: 'schedule', data: { ...single, device_id: deviceId } });
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
  if (!(await requireDeviceAccess(req, res, deviceId))) return;
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const items = rawItems.slice(0, 4).map((item) => ({
    hour: Math.max(0, Math.min(23, Number(item.hour ?? item.h) || 0)),
    minute: Math.max(0, Math.min(59, Number(item.minute ?? item.m) || 0)),
    grams: Math.max(1, Math.min(200, Number(item.grams ?? item.g) || 30)),
    enabled: Boolean(item.enabled ?? item.on ?? true),
  }));
  if (!(await persistSchedulesToFirestore(deviceId, items))) {
    return res.status(503).json({ error: 'schedule_store_unavailable' });
  }
  schedulesByDevice.set(deviceId, items);

  const cmdEntry = enqueueCommand(deviceId, 'SET_SCHEDULES', { items });
  if (!(await saveCommandOrRespond(cmdEntry, res))) return;
  const sent = await dispatchCommand(cmdEntry);
  if (items[0]) {
    broadcast({ type: 'schedule', data: { ...items[0], device_id: deviceId } });
  }
  res.json({ ok: true, sent, items, cid: cmdEntry.cid });
});

app.get('/api/alerts', auth(['admin', 'owner', 'viewer']), async (req, res) => {
  const deviceId = String(req.query.device || '');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  if (deviceId && !(await requireDeviceAccess(req, res, deviceId))) return;
  const accessibleIds = deviceId ? [deviceId] : await getAccessibleDeviceIds(req.user);
  if (accessibleIds && accessibleIds.length === 0) return res.json({ data: [] });
  if (firestoreDb) {
    try {
      let query = firestoreDb.collection('alerts');
      if (deviceId || accessibleIds?.length === 1) query = query.where('device_id', '==', deviceId || accessibleIds[0]);
      else if (accessibleIds) query = query.where('device_id', 'in', accessibleIds.slice(0, 30));
      const snap = await query.orderBy('created_at', 'desc').limit(limit).get();
      return res.json({
        data: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      });
    } catch (error) {
      console.error('[API] /api/alerts lỗi:', error.message);
    }
  }
  const filtered = accessibleIds
    ? recentAlerts.filter((a) => accessibleIds.includes(a.device_id))
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
  const deviceId = String(payload.data?.device_id || payload.data?.device || '');
  const data = JSON.stringify(payload);
  for (const client of dashboardSockets) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (deviceId && !canAccessDeviceRecord(client.user, knownDevices.get(deviceId))) continue;
    client.send(data);
  }
}

function deviceSnapshot(user = null) {
  const connectedIds = new Set(
    [...deviceSockets]
      .filter((socket) => socket.readyState === WebSocket.OPEN && socket.deviceId)
      .map((socket) => socket.deviceId)
  );
  const ids = new Set([...knownDevices.keys(), ...lastSeenMsByDevice.keys(), ...connectedIds]);
  return [...ids]
    .filter((id) => !user || canAccessDeviceRecord(user, knownDevices.get(id)))
    .map((id) => {
      const publicFields = { ...(knownDevices.get(id) || {}) };
      delete publicFields.owner_id;
      delete publicFields.member_ids;
      return {
        ...publicFields,
        id,
        online: connectedIds.has(id),
        last_seen: knownDevices.get(id)?.last_seen || null,
      };
    });
}

function broadcastDeviceStatus() {
  for (const client of dashboardSockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'status', devices: deviceSnapshot(client.user) }));
    }
  }
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

async function onTelemetry(socket, message) {
  if (message.hello) {
    const helloDeviceId = String(message.hello);
    if (socket.authenticatedDeviceId && helloDeviceId !== socket.authenticatedDeviceId) {
      socket.close(4001, 'device id mismatch');
      return;
    }
    socket.deviceId = helloDeviceId;
    lastSeenMsByDevice.set(socket.deviceId, Date.now());
    rememberDevice(socket.deviceId, { online: true, last_seen: new Date().toISOString() });
    console.log(`[WS] Thiet bi ${socket.deviceId} dang ky`);
    alertEngine.markOnline(socket.deviceId);
    updateDeviceOnline(socket.deviceId, true);
    broadcastDeviceStatus();
    const pendingOfflineTimer = offlineTimers.get(socket.deviceId);
    if (pendingOfflineTimer) clearTimeout(pendingOfflineTimer);
    offlineTimers.delete(socket.deviceId);
    flushDeviceCommands(socket.deviceId, socket).catch((err) =>
      console.error('[CMD] Không đồng bộ được hàng đợi:', err.message)
    );
    return;
  }

  if (message.cack !== undefined) {
    const cid = Number(message.cack);
    const cmd = pendingCommands.get(cid);
    if (cmd && cmd.device_id === socket.deviceId && message.ok === true) {
      cmd.acked = true;
      cmd.delivered_at = new Date().toISOString();
    }
    if (cmd && cmd.device_id === socket.deviceId && message.ok === true && firestoreDb && Number.isFinite(cid)) {
      firestoreDb
        .collection('device_commands')
        .doc(String(cid))
        .set(
          { acked: true, delivered_at: new Date().toISOString() },
          { merge: true }
        )
        .catch(() => {});
    }
    console.log(`[CMD] CACK cid=${cid} ok=${Boolean(message.ok)}`);
    return;
  }

  const seq = Number(message.s);
  const deviceId = String(message.id || socket.deviceId || 'unknown');
  if (socket.authenticatedDeviceId && deviceId !== socket.authenticatedDeviceId) {
    socket.close(4001, 'device id mismatch');
    return;
  }
  if (!Number.isFinite(seq)) {
    console.warn('[WS] Goi tin khong hop le:', message);
    return;
  }
  socket.deviceId = deviceId;
  lastSeenMsByDevice.set(deviceId, Date.now());
  rememberDevice(deviceId, { online: true, last_seen: new Date().toISOString() });

  const packetKey = `${deviceId}:${seq}`;
  if (seenPackets.has(packetKey)) {
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
    original_status: Number.isFinite(Number(message.os)) ? Number(message.os) : Number(message.st) || 0,
    feed_source: ({ 1: 'manual', 2: 'schedule', 3: 'button' })[Number(message.src)] || 'manual',
    error_code: Number(message.e) || 0,
    buffered: Number(message.q) || 0,
    synced: Number(message.st) === 2,
    raw: message,
  };
  rememberDevice(deviceId, {
    online: true,
    last_seen: record.recorded_at,
    bowl_weight_g: record.weight_g,
    food_level: record.food_level,
  });

  // ACK sau khi Firestore hoặc spool cục bộ xác nhận nhận dữ liệu bền.
  if (firestoreDb) {
    const spoolPath = TELEMETRY_SPOOL_PATH;
    const processingPath = `${spoolPath}.processing`;
    const spoolHasBacklog = fs.existsSync(spoolPath) || fs.existsSync(processingPath);
    if (spoolHasBacklog || !(await persistTelemetry(record))) {
      try {
        appendTelemetrySpool(record);
      } catch (err) {
        console.error(`[WS] Khong the luu spool seq=${seq}:`, err.message);
        return;
      }
    }
  }
  rememberPacket(packetKey);
  socket.send(JSON.stringify({ ack: seq }));
  recentTelemetry.push(record);
  if (recentTelemetry.length > MAX_RECENT) recentTelemetry.shift();

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
}

// ------------------------------------------------------------
// Cloud Firestore Persistence (100% Firebase Spark)
// ------------------------------------------------------------
async function persistTelemetry(record) {
  if (!firestoreDb) return false;
  try {
    // Ghi telemetry, trạng thái thiết bị và thống kê trong cùng transaction để
    // spool retry không cộng dồn stats hai lần nếu log đã được ghi trước đó.
    const logRef = firestoreDb.collection('telemetry_logs').doc(
      `${record.device_id}_${record.seq_num}`
    );
    const deviceRef = firestoreDb.collection('devices').doc(record.device_id);
    const logData = {
      device_id: record.device_id,
      seq_num: record.seq_num,
      recorded_at: record.recorded_at,
      weight_g: record.weight_g,
      food_level: record.food_level,
      status: record.status,
      error_code: record.error_code,
      synced: record.synced,
      raw: record.raw,
    };
    await firestoreDb.runTransaction(async (transaction) => {
      const existing = await transaction.get(logRef);
      if (existing.exists) return;

      const deviceSnapshot = await transaction.get(deviceRef);
      const previousWeight = deviceSnapshot.exists
        ? Number(deviceSnapshot.data()?.bowl_weight_g)
        : NaN;
      transaction.create(logRef, logData);
      transaction.set(
        deviceRef,
        {
        id: record.device_id,
        online: true,
        last_seen: record.recorded_at,
        bowl_weight_g: record.weight_g,
        food_level: record.food_level,
        },
        { merge: true }
      );

      if (Number.isFinite(previousWeight) && record.status !== 1 &&
          record.weight_g < previousWeight - 0.5) {
        const eatenDelta = +(previousWeight - record.weight_g).toFixed(1);
        const { hourRef, dayRef, hourBucket, dayBucket } = consumptionStatRefs(
          record.device_id,
          record.recorded_at
        );
        const increment = firebaseAdmin.firestore.FieldValue.increment(eatenDelta);
        transaction.set(hourRef, {
          device_id: record.device_id,
          bucket: hourBucket,
          eaten_g: increment,
        }, { merge: true });
        transaction.set(dayRef, {
          device_id: record.device_id,
          bucket: dayBucket,
          eaten_g: increment,
        }, { merge: true });
      }
    });
    return true;
  } catch (error) {
    console.error('[FIRESTORE:telemetry_logs]', error.message);
    return false;
  }
}

function appendTelemetrySpool(record) {
  fs.mkdirSync(path.dirname(TELEMETRY_SPOOL_PATH), { recursive: true });
  const fd = fs.openSync(TELEMETRY_SPOOL_PATH, 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function flushSpool() {
  if (!firestoreDb) return;
  const processingPath = `${TELEMETRY_SPOOL_PATH}.processing`;
  if (!fs.existsSync(processingPath) && fs.existsSync(TELEMETRY_SPOOL_PATH)) {
    try {
      // Rotate first so new arrivals append to a separate file while Firestore writes await.
      fs.renameSync(TELEMETRY_SPOOL_PATH, processingPath);
    } catch (err) {
      console.error('[SPOOL] Khong the rotate spool:', err.message);
      return;
    }
  }
  if (!fs.existsSync(processingPath)) return;
  let lines;
  try {
    lines = fs.readFileSync(processingPath, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (err) {
    console.error('[SPOOL] Khong doc duoc spool:', err.message);
    return;
  }
  const remaining = [];
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      remaining.push(line);
      continue;
    }
    // Firestore set với ID tất định chấp nhận bản ghi trùng (tương đương HTTP 409).
    if (!(await persistTelemetry(record))) remaining.push(line);
  }
  const tempPath = `${processingPath}.tmp`;
  try {
    if (!remaining.length) {
      fs.unlinkSync(processingPath);
    } else {
      fs.writeFileSync(tempPath, `${remaining.join('\n')}\n`);
      const fd = fs.openSync(tempPath, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tempPath, processingPath);
    }
  } catch (err) {
    console.error('[SPOOL] Khong cap nhat duoc spool:', err.message);
  }
}

setInterval(() => {
  if (spoolFlushInProgress) return;
  spoolFlushInProgress = true;
  flushSpool()
    .catch((err) => console.error('[SPOOL] Flush error:', err.message))
    .finally(() => { spoolFlushInProgress = false; });
}, 5000).unref();

function consumptionStatRefs(deviceId, recordedAtIso) {
  const d = new Date(recordedAtIso);
  const vnTime = new Date(d.getTime() + 7 * 3600 * 1000);
  const y = vnTime.getUTCFullYear();
  const mo = String(vnTime.getUTCMonth() + 1).padStart(2, '0');
  const da = String(vnTime.getUTCDate()).padStart(2, '0');
  const ho = String(vnTime.getUTCHours()).padStart(2, '0');

  const hourBucket = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())).toISOString();
  const dayBucket = `${y}-${mo}-${da}T00:00:00.000+07:00`;

  return {
    hourRef: firestoreDb.collection('stats_hourly').doc(`${deviceId}_${y}${mo}${da}${ho}`),
    dayRef: firestoreDb.collection('stats_daily').doc(`${deviceId}_${y}${mo}${da}`),
    hourBucket,
    dayBucket,
  };
}

async function persistSchedulesToFirestore(deviceId, items) {
  if (!firestoreDb) return true;
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
    return true;
  } catch (error) {
    console.error('[FIRESTORE:feeding_schedules]', error.message);
    return false;
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
  if (!deviceId) return;
  rememberDevice(deviceId, {
    online,
    ...(online ? { last_seen: new Date().toISOString() } : {}),
  });
  if (!firestoreDb) return;
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

function scheduleOfflineAlert(deviceId, lastSeenMs) {
  const prior = offlineTimers.get(deviceId);
  if (prior) clearTimeout(prior);
  const delay = Math.max(0, OFFLINE_STALE_MS - (Date.now() - lastSeenMs));
  const timer = setTimeout(() => {
    const connected = [...deviceSockets].some(
      (socket) => socket.deviceId === deviceId && socket.readyState === WebSocket.OPEN
    );
    if (!connected) {
      updateDeviceOnline(deviceId, false);
      alertEngine.markOffline(deviceId);
      broadcastDeviceStatus();
    }
    offlineTimers.delete(deviceId);
  }, delay);
  offlineTimers.set(deviceId, timer);
  timer.unref?.();
}

async function hydrateDeviceState() {
  if (!firestoreDb) return;
  try {
    const snap = await firestoreDb.collection('devices').get();
    for (const doc of snap.docs) {
      const row = doc.data() || {};
      const id = String(row.id || doc.id);
      rememberDevice(id, { ...row, online: false });
      const lastSeenMs = timestampMillis(row.last_seen);
      if (Number.isFinite(lastSeenMs)) {
        lastSeenMsByDevice.set(id, lastSeenMs);
        if (row.online) scheduleOfflineAlert(id, lastSeenMs);
      }
    }
    broadcastDeviceStatus();
  } catch (error) {
    console.error('[FIRESTORE:devices] initial state read:', error.message);
  }
}

hydrateDeviceState();

// Re-check persisted last_seen values as well as devices seen in this process.
setInterval(async () => {
  const now = Date.now();
  for (const [deviceId, lastSeenMs] of lastSeenMsByDevice.entries()) {
    const connected = [...deviceSockets].some(
      (s) => s.deviceId === deviceId && s.readyState === WebSocket.OPEN
    );
    if (!connected && now - lastSeenMs >= OFFLINE_STALE_MS && knownDevices.get(deviceId)?.online !== false) {
      await updateDeviceOnline(deviceId, false);
      alertEngine.markOffline(deviceId);
      broadcastDeviceStatus();
    }
  }
}, 60_000).unref();

async function onDashboardCommand(socket, message) {
  const role = socket.user?.role || 'viewer';
  if (!['admin', 'owner'].includes(role)) {
    socket.send(JSON.stringify({ type: 'error', error: 'forbidden' }));
    return;
  }
  const deviceId = String(message.device || 'esp01');
  if (!(await userCanAccessDevice(socket.user, deviceId))) {
    socket.send(JSON.stringify({ type: 'error', error: 'device_forbidden' }));
    return;
  }
  const cmd = String(message.cmd || '').toUpperCase();
  if (cmd === 'FEED') {
    const cmdEntry = enqueueCommand(deviceId, 'FEED', { g: Number(message.g) || 30 });
    if (!(await persistCommand(cmdEntry))) {
      pendingCommands.delete(cmdEntry.cid);
      socket.send(JSON.stringify({ type: 'error', error: 'command_queue_unavailable' }));
      return;
    }
    await dispatchCommand(cmdEntry);
  } else if (cmd === 'STOP') {
    const cmdEntry = enqueueCommand(deviceId, 'STOP', {});
    if (!(await persistCommand(cmdEntry))) {
      pendingCommands.delete(cmdEntry.cid);
      socket.send(JSON.stringify({ type: 'error', error: 'command_queue_unavailable' }));
      return;
    }
    await dispatchCommand(cmdEntry);
  } else if (cmd === 'CLEAR_ERROR') {
    const cmdEntry = enqueueCommand(deviceId, 'CLEAR_ERROR', {});
    if (!(await persistCommand(cmdEntry))) {
      pendingCommands.delete(cmdEntry.cid);
      socket.send(JSON.stringify({ type: 'error', error: 'command_queue_unavailable' }));
      return;
    }
    await dispatchCommand(cmdEntry);
  } else {
    socket.send(JSON.stringify({ type: 'error', error: 'unknown command' }));
  }
}

wss.on('connection', async (socket, request) => {
  // Attach before awaiting auth; malformed/aborted clients can emit errors meanwhile.
  socket.on('error', (error) => {
    console.error('[WS] Socket error:', error.message);
  });

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const role = url.searchParams.get('role') || 'dashboard';
  const token = url.searchParams.get('token') || '';

  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  if (role === 'device') {
    const requestedDeviceId = String(
      request.headers['x-device-id'] || url.searchParams.get('id') || ''
    ).trim();
    if (!(await deviceAuthorized(request, token, requestedDeviceId))) {
      console.warn('[WS] Tu choi thiet bi: sai DEVICE_TOKEN');
      socket.close(4001, 'invalid device token');
      return;
    }
    socket.authenticatedDeviceId = requestedDeviceId || null;
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
    const visibleDevices = deviceSnapshot(socket.user);
    const defaultDeviceId = visibleDevices[0]?.id || (socket.user.role === 'admin' ? 'esp01' : null);
    const defaultSchedules = defaultDeviceId ? getDeviceSchedules(defaultDeviceId) : [];
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        data: {
          devices: visibleDevices,
          recent: recentTelemetry
            .filter((record) => canAccessDeviceRecord(socket.user, knownDevices.get(record.device_id)))
            .slice(-50),
          schedule: defaultSchedules[0] || (defaultDeviceId
            ? { enabled: false, hour: 8, minute: 0, grams: 30 }
            : null),
          schedules: defaultSchedules,
          alerts: recentAlerts
            .filter((alert) => canAccessDeviceRecord(socket.user, knownDevices.get(alert.device_id)))
            .slice(0, 20),
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
      onTelemetry(socket, message).catch((err) =>
        console.error('[WS] Telemetry handler:', err.message)
      );
    } else if (message.cmd) {
      onDashboardCommand(socket, message).catch((err) =>
        console.error('[CMD] Dashboard command:', err.message)
      );
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
        broadcastDeviceStatus();
        const prior = offlineTimers.get(socket.deviceId);
        if (prior) clearTimeout(prior);
        scheduleOfflineAlert(socket.deviceId, lastSeenMsByDevice.get(socket.deviceId) || Date.now());
      }
    }
    broadcastDeviceStatus();
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
server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log(`  Pet Feeder Gateway - http://${HOST}:${PORT}`);
  console.log(`  WebSocket: ws://${HOST}:${PORT}/ws`);
  console.log(`  Dashboard: http://${HOST}:${PORT}/index.html`);
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
