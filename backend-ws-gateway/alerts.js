/**
 * [SV2: T-SV2-03] Alert Engine & Feeding Event Detector
 *
 * Quy tắc theo agent/TODO.md §2.7:
 *  - LOW_FOOD : food_level < 15%, hysteresis hồi phục khi >= 25%, tối đa 1 lần / 30 phút
 *  - EMPTY    : error_code === 2, tối đa 1 lần / 30 phút
 *  - JAM      : error_code === 1, gửi ngay 1 lần mỗi sự cố đến khi hết lỗi
 *  - SENSOR   : error_code === 3, tối đa 1 lần / 30 phút
 *  - OFFLINE  : mất kết nối quá 60s (markOffline)
 *  - ONLINE   : kết nối lại sau OFFLINE (markOnline)
 *  - Feeding  : phát hiện chuyển trạng thái st 1 -> 0 để suy ra feeding_events
 */
'use strict';

const LOW_FOOD_THRESHOLD = 15;
const LOW_FOOD_HYSTERESIS = 25;
const COOLDOWN_MS = 30 * 60 * 1000;

function createAlertEngine({
  onAlert = () => {},
  onFeedingEvent = () => {},
  nowFn = () => Date.now(),
} = {}) {
  const deviceStates = new Map();

  function getState(deviceId) {
    let state = deviceStates.get(deviceId);
    if (!state) {
      state = {
        lowFoodLatched: false,
        jamActive: false,
        offlineNotified: false,
        lastSentAt: new Map(), // kind -> timestamp ms
        lastStatus: null,
        activeFeed: null, // { started_at, startWeight }
      };
      deviceStates.set(deviceId, state);
    }
    return state;
  }

  function emitAlert(deviceId, kind, message, now) {
    const state = getState(deviceId);
    const prev = state.lastSentAt.get(kind);
    if (prev !== undefined && now - prev < COOLDOWN_MS && kind !== 'JAM' && kind !== 'OFFLINE' && kind !== 'ONLINE') {
      return null;
    }
    state.lastSentAt.set(kind, now);
    const alert = {
      id: `${deviceId}-${kind}-${now}`,
      device_id: deviceId,
      kind,
      message,
      created_at: new Date(now).toISOString(),
      pushed: false,
      read_at: null,
    };
    onAlert(alert);
    return alert;
  }

  function processTelemetry(record) {
    const now = nowFn();
    const deviceId = record.device_id || 'esp01';
    const state = getState(deviceId);
    const emitted = [];
    const feedingStatus = Number.isFinite(record.original_status)
      ? record.original_status
      : record.status;

    // 1) Mức thức ăn thấp (có hysteresis 15% / 25%)
    if (record.food_level < LOW_FOOD_THRESHOLD) {
      if (!state.lowFoodLatched) {
        const alert = emitAlert(
          deviceId,
          'LOW_FOOD',
          `Thùng hạt thiết bị ${deviceId} sắp hết (${record.food_level}%)`,
          now
        );
        if (alert) emitted.push(alert);
        state.lowFoodLatched = true;
      }
    } else if (record.food_level >= LOW_FOOD_HYSTERESIS) {
      state.lowFoodLatched = false;
    }

    // 2) Mã lỗi thiết bị
    if (record.error_code === 1) {
      if (!state.jamActive) {
        state.jamActive = true;
        const alert = emitAlert(
          deviceId,
          'JAM',
          `Phát hiện kẹt hạt trên thiết bị ${deviceId}`,
          now
        );
        if (alert) emitted.push(alert);
      }
    } else {
      state.jamActive = false;
    }

    if (record.error_code === 2) {
      const alert = emitAlert(
        deviceId,
        'EMPTY',
        `Thùng hạt thiết bị ${deviceId} đã cạn`,
        now
      );
      if (alert) emitted.push(alert);
    } else if (record.error_code === 3) {
      const alert = emitAlert(
        deviceId,
        'SENSOR',
        `Lỗi cảm biến trên thiết bị ${deviceId}`,
        now
      );
      if (alert) emitted.push(alert);
    }

    // 3) Phát hiện sự kiện cho ăn (st: 1 -> 0 hoặc 3)
    if (feedingStatus === 1 && state.lastStatus !== 1) {
      state.activeFeed = {
        started_at: record.recorded_at || new Date(now).toISOString(),
        startWeight: record.weight_g,
        source: record.feed_source || 'manual',
      };
    } else if (state.activeFeed && feedingStatus !== 1 && feedingStatus !== 2) {
      const dispensed = Math.max(0, +(record.weight_g - state.activeFeed.startWeight).toFixed(1));
      const result = record.error_code === 1 ? 1 : record.error_code === 2 ? 3 : 0;
      onFeedingEvent({
        device_id: deviceId,
        started_at: state.activeFeed.started_at,
        finished_at: record.recorded_at || new Date(now).toISOString(),
        source: state.activeFeed.source,
        target_g: null,
        dispensed_g: dispensed,
        result,
      });
      state.activeFeed = null;
    }

    state.lastStatus = feedingStatus;
    return emitted;
  }

  function markOffline(deviceId) {
    const state = getState(deviceId);
    if (state.offlineNotified) return null;
    state.offlineNotified = true;
    return emitAlert(
      deviceId,
      'OFFLINE',
      `Thiết bị ${deviceId} đã mất kết nối mạng`,
      nowFn()
    );
  }

  function markOnline(deviceId) {
    const state = getState(deviceId);
    if (!state.offlineNotified) return null;
    state.offlineNotified = false;
    return emitAlert(
      deviceId,
      'ONLINE',
      `Thiết bị ${deviceId} đã kết nối mạng trở lại`,
      nowFn()
    );
  }

  return {
    processTelemetry,
    markOffline,
    markOnline,
  };
}

module.exports = { createAlertEngine, LOW_FOOD_THRESHOLD, LOW_FOOD_HYSTERESIS, COOLDOWN_MS };
