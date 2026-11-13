#pragma once

#include <Arduino.h>
#include <LittleFS.h>

#include "config.h"
#include "packet_schema.h"

// ============================================================
// [SV2] Two-Tier Offline Ring Buffer
//  Tầng 1: RAM ring 64 bản ghi x 16 bytes = 1 KB SRAM
//  Tầng 2: LittleFS /offline_queue.bin, tối đa 500 bản ghi (~8 KB)
// ============================================================
#define RAM_BUFFER_CAPACITY 64
#define FLASH_BUFFER_CAPACITY 500
#define FLASH_QUEUE_PATH "/offline_queue.bin"

struct __attribute__((packed)) FlashQueueHeader {
  uint32_t magic;
  uint16_t head;   // vị trí ghi kế tiếp
  uint16_t count;  // số bản ghi đang giữ
};

class RingBuffer {
 public:
  bool begin();

  // ----- Tầng RAM (gói mới / chờ ACK khi online) -----
  void push(const TelemetryRecord& rec);
  bool peek(TelemetryRecord& out) const;
  void pop();
  bool isEmpty() const { return _count == 0; }
  uint16_t count() const { return _count; }

  // ----- Tầng Flash (offline / sự kiện quan trọng) -----
  void pushFlash(const TelemetryRecord& rec);
  bool peekFlash(TelemetryRecord& out) const;
  void popFlash();
  uint16_t flashCount() const { return _flashCount; }
  void clearFlash();

  uint16_t pendingCount() const { return (uint16_t)(_count + _flashCount); }
  // Chuyển các gói RAM chưa kịp ACK xuống Flash khi mất kết nối.
  void dumpRamToFlash();

 private:
  TelemetryRecord _ram[RAM_BUFFER_CAPACITY];
  uint16_t _head = 0;
  uint16_t _tail = 0;
  uint16_t _count = 0;

  uint16_t _flashHead = 0;
  uint16_t _flashCount = 0;
  bool _mounted = false;

  void _writeFlashHeader(File& file);
};
