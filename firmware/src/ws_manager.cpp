#include "ws_manager.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <sys/time.h>

void WsManager::begin(RingBuffer* ringBuffer) {
  _rb = ringBuffer;

  _cmdPrefs.begin(NVS_NAMESPACE_CMD, false);
  _recentCidCount = _cmdPrefs.getUChar("count", 0);
  if (_recentCidCount > CMD_DEDUP_WINDOW) _recentCidCount = CMD_DEDUP_WINDOW;
  _recentCidNext = _cmdPrefs.getUChar("next", 0) % CMD_DEDUP_WINDOW;
  for (uint8_t i = 0; i < CMD_DEDUP_WINDOW; i++) {
    char key[8];
    snprintf(key, sizeof(key), "cid%u", (unsigned)i);
    _recentCids[i] = _cmdPrefs.getUInt(key, 0);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // tự quản lý backoff
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WS] Dang ket noi WiFi \"%s\"\n", WIFI_SSID);

  char deviceHeaders[128];
  snprintf(deviceHeaders, sizeof(deviceHeaders),
           "Authorization: Bearer %s\r\nX-Device-ID: %s",
           DEVICE_TOKEN, DEVICE_ID);
  _ws.setExtraHeaders(deviceHeaders);
#if PETTY_TLS
  // beginSSL's fourth parameter is a leaf-certificate fingerprint in this
  // library; use the CA-specific API so the PEM is parsed as a trust anchor.
  _ws.beginSslWithCA(WS_HOST, WS_PORT, WS_PATH, PETTY_ROOT_CA);
#else
  _ws.begin(WS_HOST, WS_PORT, WS_PATH);
#endif
  _ws.setReconnectInterval(BACKOFF_BASE_MS);
  _ws.enableHeartbeat(WS_HEARTBEAT_INTERVAL_MS, 3000, 2);
  _ws.onEvent([this](WStype_t type, uint8_t* payload, size_t length) {
    _onEvent(type, payload, length);
  });
}

void WsManager::update() {
  _ws.loop();

  if (_dropped) {
    return;  // WIFI_DROP đang giả lập mất mạng
  }

  // Watchdog Wi-Fi: thử lại mỗi 10s nếu rớt mạng thật.
  static uint32_t lastWifiTry = 0;
  if (WiFi.status() != WL_CONNECTED &&
      millis() - lastWifiTry >= WIFI_RETRY_INTERVAL_MS) {
    lastWifiTry = millis();
    WiFi.reconnect();
  }

  if (!_connected || _rb == nullptr) {
    return;
  }

  if (_state == STATE_RECONNECTED_SYNCING) {
    _syncStep();
    return;
  }

  // ONLINE_NORMAL: gửi lần lượt từng gói, chờ ACK rồi mới pop().
  if (_rb->isEmpty()) {
    return;
  }

  TelemetryRecord rec;
  if (!_awaiting) {
    if (_rb->peek(rec)) {
      _sendRecord(rec, false);
      _awaiting = true;
      _awaitFromFlash = false;
      _awaitSeq = rec.seq;
      _awaitSince = millis();
    }
  } else if (millis() - _awaitSince >= WS_ACK_TIMEOUT_MS) {
    if (_rb->peek(rec)) {
      Serial.printf("[WS] ACK timeout s=%lu - gui lai\n", (unsigned long)rec.seq);
      _sendRecord(rec, false);
      _awaitSince = millis();
    }
  }
}

void WsManager::publish(const TelemetryRecord& rec) {
  if (_rb == nullptr) {
    return;
  }
  if (_connected && _state == STATE_ONLINE_NORMAL) {
    _rb->push(rec);
  } else {
    // Mất mạng hoặc đang đồng bộ: ghi bền xuống LittleFS.
    _rb->pushFlash(rec);
    Serial.printf("[WS] Buffer offline s=%lu (tong %u)\n",
                  (unsigned long)rec.seq, (unsigned)_rb->pendingCount());
  }
}

bool WsManager::popCommand(Command& out) {
  if (_commandCount == 0) {
    return false;
  }
  out = _commands[_commandHead];
  _commandHead = (uint8_t)((_commandHead + 1) % COMMAND_QUEUE_SIZE);
  _commandCount--;
  return true;
}

bool WsManager::_queueCommand(const Command& cmd) {
  if (cmd.cid != 0 && _hasRecentCid(cmd.cid)) {
    ackCommand(cmd.cid, true);
    return true;
  }
  if (_commandCount == COMMAND_QUEUE_SIZE) {
    ackCommand(cmd.cid, false);
    return false;
  }
  const uint8_t slot =
      (uint8_t)((_commandHead + _commandCount) % COMMAND_QUEUE_SIZE);
  _commands[slot] = cmd;
  _commandCount++;
  return true;
}

bool WsManager::_hasRecentCid(uint32_t cid) const {
  for (uint8_t i = 0; i < _recentCidCount; i++) {
    if (_recentCids[i] == cid) return true;
  }
  return false;
}

void WsManager::_rememberCid(uint32_t cid) {
  _recentCids[_recentCidNext] = cid;
  char key[8];
  snprintf(key, sizeof(key), "cid%u", (unsigned)_recentCidNext);
  _cmdPrefs.putUInt(key, cid);
  _recentCidNext = (uint8_t)((_recentCidNext + 1) % CMD_DEDUP_WINDOW);
  if (_recentCidCount < CMD_DEDUP_WINDOW) _recentCidCount++;
  _cmdPrefs.putUChar("count", _recentCidCount);
  _cmdPrefs.putUChar("next", _recentCidNext);
}

void WsManager::ackCommand(uint32_t cid, bool ok) {
  if (cid == 0 || !_connected) return;
  if (ok && !_hasRecentCid(cid)) _rememberCid(cid);
  char payload[48];
  if (encodeCommandAckJson(cid, ok, payload, sizeof(payload)) > 0) {
    _ws.sendTXT(payload);
  }
}

void WsManager::_sendRecord(const TelemetryRecord& rec, bool offlineSynced) {
  char payload[160];
  // Khong tinh goi dang truyen cho ACK de card Ring Buffer chi tang khi co ton dong.
  const uint16_t queuedBehind =
      (_rb && _rb->pendingCount() > 0) ? (uint16_t)(_rb->pendingCount() - 1) : 0;
  encodeTelemetryJson(rec, payload, sizeof(payload), offlineSynced, queuedBehind);
  _ws.sendTXT(payload);
  Serial.printf("[WS] %s s=%lu t=%lu w=%.1f l=%u st=%u e=%u\n",
                offlineSynced ? "SYNC" : "TX", (unsigned long)rec.seq,
                (unsigned long)rec.ts, (double)rec.weight, (unsigned)rec.level,
                (unsigned)(offlineSynced ? ST_OFFLINE_SYNCED : (rec.status & 0x03)),
                (unsigned)rec.error);
}

void WsManager::_handleAck(uint32_t seq) {
  if (!_awaiting || seq != _awaitSeq || _rb == nullptr) {
    return;
  }
  if (_awaitFromFlash) {
    _rb->popFlash();
  } else {
    _rb->pop();
  }
  _awaiting = false;
  Serial.printf("[WS] ACK s=%lu - con %u goi trong buffer\n",
                (unsigned long)seq, (unsigned)_rb->pendingCount());
}

void WsManager::_syncStep() {
  if (_rb == nullptr) {
    _state = STATE_ONLINE_NORMAL;
    return;
  }

  if (_awaiting) {
    if (millis() - _awaitSince < WS_ACK_TIMEOUT_MS) {
      return;
    }
    _awaiting = false;  // quá hạn ACK -> gửi lại bản ghi cũ nhất
  }

  TelemetryRecord rec;
  if (_rb->flashCount() > 0 && _rb->peekFlash(rec)) {
    _sendRecord(rec, true);
    _awaiting = true;
    _awaitFromFlash = true;
    _awaitSeq = rec.seq;
    _awaitSince = millis();
    return;
  }

  if (_rb->peek(rec)) {
    _sendRecord(rec, true);
    _awaiting = true;
    _awaitFromFlash = false;
    _awaitSeq = rec.seq;
    _awaitSince = millis();
    return;
  }

  // Đã xử lý hết dữ liệu tồn đọng.
  _rb->clearFlash();
  _state = STATE_ONLINE_NORMAL;
  Serial.println("[WS] Dong bo xong -> STATE_ONLINE_NORMAL");
}

void WsManager::_applyBackoff() {
  uint32_t wait = BACKOFF_BASE_MS;
  for (uint8_t i = 0; i < _retry && wait < BACKOFF_MAX_MS; i++) {
    wait *= 2;
  }
  if (wait > BACKOFF_MAX_MS) {
    wait = BACKOFF_MAX_MS;
  }
  if (_retry < 5) {
    _retry++;
  }
  _ws.setReconnectInterval(wait);
  Serial.printf("[WS] Thu lai sau %lu ms\n", (unsigned long)wait);
}

void WsManager::_onEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      _connected = true;
      _retry = 0;
      _awaiting = false;
      _ws.setReconnectInterval(BACKOFF_BASE_MS);
      _ws.sendTXT("{\"hello\":\"" DEVICE_ID "\"}");
      if (_rb && _rb->pendingCount() > 0) {
        _state = STATE_RECONNECTED_SYNCING;
        Serial.printf("[WS] Ket noi lai - bat dau dong bo %u goi\n",
                      (unsigned)_rb->pendingCount());
      } else {
        _state = STATE_ONLINE_NORMAL;
        Serial.println("[WS] Online - STATE_ONLINE_NORMAL");
      }
      break;
    }

    case WStype_DISCONNECTED: {
      if (_connected) {
        Serial.println("[WS] Mat ket noi -> STATE_OFFLINE_BUFFERING");
        if (_rb) {
          _rb->dumpRamToFlash();  // giữ lại gói chưa kịp ACK
        }
      }
      _connected = false;
      _awaiting = false;
      _state = STATE_OFFLINE_BUFFERING;
      _applyBackoff();
      break;
    }

    case WStype_TEXT: {
      char text[320];
      const size_t n = length < sizeof(text) - 1 ? length : sizeof(text) - 1;
      memcpy(text, payload, n);
      text[n] = '\0';
      _handleText(text);
      break;
    }

    case WStype_ERROR:
      Serial.println("[WS] Loi socket");
      break;

    default:
      break;
  }
}

void WsManager::_handleText(const char* text) {
  JsonDocument doc;
  if (deserializeJson(doc, text) != DeserializationError::Ok) {
    Serial.printf("[WS] JSON loi: %s\n", text);
    return;
  }

  if (doc["ts"].is<uint64_t>()) {
    struct timeval tv = {(time_t)doc["ts"].as<uint64_t>(), 0};
    settimeofday(&tv, nullptr);
  }

  if (doc["ack"].is<uint32_t>()) {
    _handleAck(doc["ack"].as<uint32_t>());
    return;
  }

  if (!doc["cack"].isNull()) return;  // ACK hướng thiết bị, bỏ qua

  const char* cmd = doc["cmd"];
  if (cmd == nullptr) {
    return;
  }

  Command command;
  command.cid = doc["cid"] | (uint32_t)0;
  command.expired = doc["expired"] | false;
  if (strcmp(cmd, "FEED") == 0) {
    command.type = CMD_FEED;
    command.grams = doc["g"] | FEED_TARGET_GRAMS;
  } else if (strcmp(cmd, "STOP") == 0) {
    command.type = CMD_STOP;
  } else if (strcmp(cmd, "SET_SCHEDULE") == 0) {
    command.type = CMD_SET_SCHEDULE;
    command.hour = doc["h"] | 0;
    command.minute = doc["m"] | 0;
    command.grams = doc["g"] | FEED_TARGET_GRAMS;
    command.enabled = doc["on"] | true;
  } else if (strcmp(cmd, "SET_SCHEDULES") == 0) {
    command.type = CMD_SET_SCHEDULES;
    JsonArrayConst items = doc["items"].as<JsonArrayConst>();
    command.scheduleCount = (uint8_t)min((size_t)MAX_SCHEDULES, items.size());
    for (uint8_t i = 0; i < command.scheduleCount; i++) {
      JsonObjectConst item = items[i];
      command.schedules[i].hour = item["h"] | 0;
      command.schedules[i].minute = item["m"] | 0;
      command.schedules[i].grams = item["g"] | FEED_TARGET_GRAMS;
      command.schedules[i].enabled = item["on"] | true;
    }
  } else if (strcmp(cmd, "CLEAR_ERROR") == 0) {
    command.type = CMD_CLEAR_ERROR;
  } else if (strcmp(cmd, "SIM_JAM") == 0) {
    command.type = CMD_SIM_JAM;
    command.enabled = doc["on"] | false;
  } else if (strcmp(cmd, "SIM_EAT") == 0) {
    command.type = CMD_SIM_EAT;
  } else if (strcmp(cmd, "SET_CONFIG") == 0) {
    command.type = CMD_SET_CONFIG;
    command.bowlCapacity = doc["bowl_capacity_g"] | BOWL_FULL_GRAMS;
  } else if (strcmp(cmd, "SIM_REFILL") == 0) {
    command.type = CMD_SIM_REFILL;
  } else {
    Serial.printf("[WS] Lenh khong ho tro: %s\n", cmd);
    return;
  }

  if (!_queueCommand(command)) {
    Serial.printf("[WS] Hang doi day, tu choi lenh: %s\n", cmd);
    return;
  }
  Serial.printf("[WS] Nhan lenh: %s\n", cmd);
}

void WsManager::toggleNetworkDrop() {
  if (!_dropped) {
    _dropped = true;
    _connected = false;
    _awaiting = false;
    _state = STATE_OFFLINE_BUFFERING;
    _ws.disconnect();
    WiFi.disconnect(true, false);
    Serial.println("[WS] WIFI_DROP -> gia lap mat mang");
  } else {
    _dropped = false;
    _retry = 0;
    _ws.setReconnectInterval(BACKOFF_BASE_MS);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.println("[WS] WIFI_DROP -> khoi phuc ket noi");
  }
}
