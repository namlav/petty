#pragma once

#include <Arduino.h>
#include <WebSocketsClient.h>

#include "config.h"
#include "packet_schema.h"
#include "ring_buffer.h"

// ============================================================
// [SV2] Wi-Fi + WebSocket + Exponential Backoff + Auto-Sync
// ============================================================
enum WsState : uint8_t {
  STATE_ONLINE_NORMAL = 0,
  STATE_OFFLINE_BUFFERING,
  STATE_RECONNECTED_SYNCING,
};

class WsManager {
 public:
  void begin(RingBuffer* ringBuffer);
  void update();

  // Online: xếp RAM chờ ACK. Offline: ghi thẳng xuống LittleFS.
  void publish(const TelemetryRecord& rec);

  WsState state() const { return _state; }
  bool isConnected() const { return _connected; }
  uint16_t pendingCount() const {
    return _rb ? _rb->pendingCount() : 0;
  }
  bool popCommand(Command& out);
  void toggleNetworkDrop();
  bool networkDropped() const { return _dropped; }

 private:
  static const uint8_t COMMAND_QUEUE_SIZE = 4;

  WebSocketsClient _ws;
  RingBuffer* _rb = nullptr;

  WsState _state = STATE_OFFLINE_BUFFERING;
  bool _connected = false;
  bool _dropped = false;
  uint8_t _retry = 0;

  bool _awaiting = false;
  bool _awaitFromFlash = false;
  uint32_t _awaitSeq = 0;
  uint32_t _awaitSince = 0;

  Command _commands[COMMAND_QUEUE_SIZE];
  uint8_t _commandHead = 0;
  uint8_t _commandCount = 0;

  void _onEvent(WStype_t type, uint8_t* payload, size_t length);
  void _handleText(const char* text);
  void _handleAck(uint32_t seq);
  void _queueCommand(const Command& cmd);
  void _sendRecord(const TelemetryRecord& rec, bool offlineSynced);
  void _syncStep();
  void _applyBackoff();
};
