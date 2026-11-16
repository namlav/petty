'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlertEngine } = require('../alerts');

function makeEngine() {
  let now = 0;
  const alerts = [];
  const feedingEvents = [];
  const engine = createAlertEngine({
    nowFn: () => now,
    onAlert: (alert) => alerts.push(alert),
    onFeedingEvent: (event) => feedingEvents.push(event),
  });
  return {
    engine,
    alerts,
    feedingEvents,
    setNow(value) { now = value; },
    telemetry(overrides = {}) {
      now += 1000;
      engine.processTelemetry({
        device_id: 'esp01',
        food_level: 50,
        status: 0,
        error_code: 0,
        weight_g: 100,
        recorded_at: new Date(now).toISOString(),
        ...overrides,
      });
    },
  };
}

test('LOW_FOOD uses hysteresis and respects the cooldown', () => {
  const state = makeEngine();
  state.telemetry({ food_level: 10 });
  state.telemetry({ food_level: 10 });
  assert.equal(state.alerts.filter((alert) => alert.kind === 'LOW_FOOD').length, 1);

  state.telemetry({ food_level: 25 });
  state.setNow(31 * 60 * 1000);
  state.telemetry({ food_level: 10 });
  assert.equal(state.alerts.filter((alert) => alert.kind === 'LOW_FOOD').length, 2);
});

test('JAM emits once per incident and can emit again after recovery', () => {
  const state = makeEngine();
  state.telemetry({ error_code: 1 });
  state.telemetry({ error_code: 1 });
  state.telemetry({ error_code: 0 });
  state.telemetry({ error_code: 1 });
  assert.equal(state.alerts.filter((alert) => alert.kind === 'JAM').length, 2);
});

test('EMPTY alert is rate-limited for 30 minutes', () => {
  const state = makeEngine();
  state.telemetry({ error_code: 2 });
  state.telemetry({ error_code: 2 });
  assert.equal(state.alerts.filter((alert) => alert.kind === 'EMPTY').length, 1);

  state.setNow(31 * 60 * 1000);
  state.telemetry({ error_code: 2 });
  assert.equal(state.alerts.filter((alert) => alert.kind === 'EMPTY').length, 2);
});

test('feeding event keeps source and calculates dispensed grams', () => {
  const state = makeEngine();
  state.telemetry({ status: 0, weight_g: 100 });
  state.telemetry({ status: 1, weight_g: 101, feed_source: 'schedule' });
  state.telemetry({ status: 0, weight_g: 131 });

  assert.equal(state.feedingEvents.length, 1);
  assert.equal(state.feedingEvents[0].source, 'schedule');
  assert.equal(state.feedingEvents[0].dispensed_g, 30);
});

test('OFFLINE and ONLINE alerts are emitted once per transition', () => {
  const state = makeEngine();
  state.engine.markOffline('esp01');
  state.engine.markOffline('esp01');
  state.engine.markOnline('esp01');
  state.engine.markOnline('esp01');
  assert.equal(state.alerts.filter((alert) => alert.kind === 'OFFLINE').length, 1);
  assert.equal(state.alerts.filter((alert) => alert.kind === 'ONLINE').length, 1);
});
