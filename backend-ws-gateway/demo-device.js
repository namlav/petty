// Local ESP32 stand-in for the dashboard demo when Wokwi cannot reach localhost.
'use strict';

const { WebSocket } = require('ws');

const url =
  process.env.DEMO_WS_URL ||
  'ws://localhost:8080/ws?role=device&token=dev-device-token';
const socket = new WebSocket(url);

let sequence = 1;
let sample = 0;
let weight = 32;
let level = 86;

function sendTelemetry(status = 0, error = 0) {
  socket.send(
    JSON.stringify({
      v: 1,
      id: 'esp01',
      s: sequence++,
      t: Math.floor(Date.now() / 1000),
      w: weight,
      l: level,
      st: status,
      e: error,
    })
  );
}

socket.on('open', () => {
  console.log('[DEMO] Simulated device connected');
  socket.send(JSON.stringify({ hello: 'esp01' }));
  const timer = setInterval(() => {
    weight = +(32 + 2.4 * Math.sin(sequence / 2)).toFixed(1);
    level = Math.max(5, 86 - Math.floor(sample / 8));
    sendTelemetry();
    sample++;
  }, 2000);
});

socket.on('message', (raw) => {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (message.ack !== undefined) {
    console.log(`[DEMO] ACK seq=${message.ack}`);
  }
  if (message.cmd === 'FEED') {
    console.log(`[DEMO] FEED ${message.g || 30}g`);
    sendTelemetry(1);
    setTimeout(() => {
      weight = +(weight + Number(message.g || 30)).toFixed(1);
      sendTelemetry(0);
    }, 2500);
  } else if (message.cmd === 'STOP') {
    console.log('[DEMO] STOP');
    sendTelemetry(0);
  }
});

socket.on('close', () => console.log('[DEMO] Simulated device disconnected'));
socket.on('error', (error) => console.error('[DEMO] WebSocket error:', error.message));
