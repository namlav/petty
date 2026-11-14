#include "ring_buffer.h"

#include <Preferences.h>

static const uint32_t FLASH_MAGIC = 0x51544550;  // "PETQ"

bool RingBuffer::begin() {
  // NVS marker phân biệt phân vùng LittleFS mới/chưa khởi tạo với filesystem
  // đã từng hoạt động. Chỉ format ở lần đầu; lỗi mount về sau không xóa queue.
  Preferences prefs;
  const bool prefsReady = prefs.begin("petty-rb", false);
  const bool fsWasInitialized =
      prefsReady && prefs.getBool("fs_ready", false);

  _mounted = LittleFS.begin(false);
  if (!_mounted) {
    if (fsWasInitialized) {
      Serial.println("[RB] LittleFS mount lỗi - giữ nguyên flash, chỉ RAM khả dụng");
      if (prefsReady) prefs.end();
      return false;
    }
    Serial.println("[RB] LittleFS chưa khởi tạo - format phân vùng lần đầu");
    if (!LittleFS.format()) {
      Serial.println("[RB] Format LittleFS thất bại");
      if (prefsReady) prefs.end();
      return false;
    }
    _mounted = LittleFS.begin(false);
    if (!_mounted) {
      Serial.println("[RB] LittleFS mount thất bại sau format");
      if (prefsReady) prefs.end();
      return false;
    }
  }
  if (prefsReady) prefs.putBool("fs_ready", true);
  if (prefsReady) prefs.end();

  File file = LittleFS.open(FLASH_QUEUE_PATH, "r+");
  bool valid = false;
  if (file && file.size() >= (size_t)sizeof(FlashQueueHeader)) {
    FlashQueueHeader header;
    file.read((uint8_t*)&header, sizeof(header));
    if (header.magic == FLASH_MAGIC && header.head < FLASH_BUFFER_CAPACITY &&
        header.count <= FLASH_BUFFER_CAPACITY) {
      _flashHead = header.head;
      _flashCount = header.count;
      valid = true;
    }
  }
  if (file) {
    file.close();
  }

  if (!valid) {
    File fresh = LittleFS.open(FLASH_QUEUE_PATH, "w");
    if (!fresh) {
      Serial.println("[RB] Khong tao duoc file offline queue");
      return false;
    }
    FlashQueueHeader header{FLASH_MAGIC, 0, 0};
    fresh.write((const uint8_t*)&header, sizeof(header));
    fresh.close();
    _flashHead = 0;
    _flashCount = 0;
  }

  Serial.printf("[RB] LittleFS OK - %u ban ghi cho dong bo\n",
                (unsigned)_flashCount);
  return true;
}

// ---------------- Tầng RAM ----------------

bool RingBuffer::push(const TelemetryRecord& rec) {
  if (_count == RAM_BUFFER_CAPACITY) {
    Serial.println("[RB] RAM queue đầy - từ chối gói mới để giữ gói chưa ACK");
    return false;
  }
  _ram[_head] = rec;
  _head = (uint16_t)((_head + 1) % RAM_BUFFER_CAPACITY);
  _count++;
  return true;
}

bool RingBuffer::peek(TelemetryRecord& out) const {
  if (_count == 0) {
    return false;
  }
  out = _ram[_tail];
  return true;
}

void RingBuffer::pop() {
  if (_count == 0) {
    return;
  }
  _tail = (uint16_t)((_tail + 1) % RAM_BUFFER_CAPACITY);
  _count--;
}

// ---------------- Tầng Flash ----------------

void RingBuffer::_writeFlashHeader(File& file) {
  FlashQueueHeader header{FLASH_MAGIC, _flashHead, _flashCount};
  file.seek(0);
  file.write((const uint8_t*)&header, sizeof(header));
}

bool RingBuffer::pushFlash(const TelemetryRecord& rec) {
  if (!_mounted) {
    return false;
  }
  if (_flashCount == FLASH_BUFFER_CAPACITY) {
    Serial.println("[RB] Flash queue đầy - giữ nguyên dữ liệu chưa ACK");
    return false;
  }
  File file = LittleFS.open(FLASH_QUEUE_PATH, "r+");
  if (!file) {
    return false;
  }
  const uint32_t offset =
      sizeof(FlashQueueHeader) + (uint32_t)_flashHead * sizeof(TelemetryRecord);
  file.seek(offset);
  if (file.write((const uint8_t*)&rec, sizeof(rec)) != sizeof(rec)) {
    file.close();
    return false;
  }

  const uint16_t oldHead = _flashHead;
  const uint16_t oldCount = _flashCount;
  _flashHead = (uint16_t)((_flashHead + 1) % FLASH_BUFFER_CAPACITY);
  _flashCount++;
  const FlashQueueHeader header{FLASH_MAGIC, _flashHead, _flashCount};
  const bool headerWritten = file.seek(0) &&
      file.write((const uint8_t*)&header, sizeof(header)) == sizeof(header);
  file.close();
  if (!headerWritten) {
    _flashHead = oldHead;
    _flashCount = oldCount;
    return false;
  }
  return true;
}

bool RingBuffer::peekFlash(TelemetryRecord& out) const {
  if (_flashCount == 0) {
    return false;
  }
  File file = LittleFS.open(FLASH_QUEUE_PATH, "r");
  if (!file) {
    return false;
  }
  const uint16_t oldest =
      (uint16_t)((_flashHead + FLASH_BUFFER_CAPACITY - _flashCount) %
                 FLASH_BUFFER_CAPACITY);
  const uint32_t offset =
      sizeof(FlashQueueHeader) + (uint32_t)oldest * sizeof(TelemetryRecord);
  file.seek(offset);
  const size_t read = file.read((uint8_t*)&out, sizeof(out));
  file.close();
  return read == sizeof(out);
}

void RingBuffer::popFlash() {
  if (_flashCount == 0 || !_mounted) {
    return;
  }
  const uint16_t oldCount = _flashCount;
  _flashCount--;
  File file = LittleFS.open(FLASH_QUEUE_PATH, "r+");
  if (!file) {
    _flashCount = oldCount;
    return;
  }
  const FlashQueueHeader header{FLASH_MAGIC, _flashHead, _flashCount};
  const bool written = file.seek(0) &&
      file.write((const uint8_t*)&header, sizeof(header)) == sizeof(header);
  file.close();
  if (!written) _flashCount = oldCount;
}

void RingBuffer::clearFlash() {
  if (!_mounted) {
    return;
  }
  _flashHead = 0;
  _flashCount = 0;
  File file = LittleFS.open(FLASH_QUEUE_PATH, "r+");
  if (!file) {
    return;
  }
  _writeFlashHeader(file);
  file.close();
}

void RingBuffer::dumpRamToFlash() {
  TelemetryRecord rec;
  while (peek(rec) && pushFlash(rec)) {
    pop();
  }
}
