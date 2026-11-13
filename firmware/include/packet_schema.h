#pragma once

#include <Arduino.h>

#include "config.h"

// ============================================================
// [SV2] Gói tin telemetry 16 bytes (packed) + Compact JSON
// {"v":1,"id":"esp01","s":104,"t":1763040000,"w":85.4,"l":72,"st":1,"e":0}
// ============================================================

#define PROTOCOL_VERSION 1

enum PacketStatus : uint8_t {
  ST_IDLE = 0,
  ST_FEEDING = 1,
  ST_OFFLINE_SYNCED = 2,
  ST_ERROR = 3,
};

enum PacketError : uint8_t {
  ERR_NONE = 0,
  ERR_JAM = 1,
  ERR_EMPTY_TANK = 2,
  ERR_SENSOR_FAULT = 3,
};

struct __attribute__((packed)) TelemetryRecord {
  uint8_t version;   // v
  uint32_t seq;      // s
  uint32_t ts;       // t
  float weight;      // w (gam, 1 chữ số thập phân)
  uint8_t level;     // l (0..100 %)
  uint8_t status;    // st
  uint8_t error;     // e
};

static_assert(sizeof(TelemetryRecord) == 16, "TelemetryRecord phai dung 16 bytes");

// Compact JSON: chỉ dùng khóa 1-2 ký tự để tiết kiệm băng thông.
// "q" là trường mở rộng (chỉ gửi khi > 0) báo số gói còn trong Ring Buffer.
inline size_t encodeTelemetryJson(const TelemetryRecord& r, char* out, size_t outSize,
                                  bool offlineSynced = false,
                                  uint16_t buffered = 0) {
  const uint8_t st = offlineSynced ? (uint8_t)ST_OFFLINE_SYNCED : r.status;
  const int written = snprintf(out, outSize,
                               "{\"v\":%u,\"id\":\"%s\",\"s\":%lu,\"t\":%lu,\"w\":%.1f,"
                               "\"l\":%u,\"st\":%u,\"e\":%u",
                               (unsigned)r.version, DEVICE_ID, (unsigned long)r.seq,
                               (unsigned long)r.ts, (double)r.weight,
                               (unsigned)r.level, (unsigned)st, (unsigned)r.error);
  if (written < 0 || (size_t)written >= outSize) {
    return 0;
  }
  if (buffered == 0) {
    return (size_t)snprintf(out + written, outSize - written, "}");
  }
  return (size_t)snprintf(out + written, outSize - written, ",\"q\":%u}",
                          (unsigned)buffered);
}

// ============================================================
// Lệnh từ Server -> thiết bị ({"cmd":"FEED","g":30}, ...)
// ============================================================
enum CommandType : uint8_t {
  CMD_NONE = 0,
  CMD_FEED,
  CMD_STOP,
  CMD_SET_SCHEDULE,
  CMD_CLEAR_ERROR,
};

struct Command {
  CommandType type = CMD_NONE;
  float grams = FEED_TARGET_GRAMS;
  uint8_t hour = 0;
  uint8_t minute = 0;
  bool enabled = false;
};
