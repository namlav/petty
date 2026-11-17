#include "ring_buffer.h"

static const uint32_t FLASH_MAGIC = 0x51544550;  // "PETQ"

bool RingBuffer::begin() {
  _mounted = LittleFS.begin(true);  // format khi mount lỗi
  if (!_mounted) {
    Serial.println("[RB] LittleFS mount that bai - chi dung RAM");
    return false;
  }

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

void RingBuffer::push(const TelemetryRecord& rec) {
  _ram[_head] = rec;
  _head = (uint16_t)((_head + 1) % RAM_BUFFER_CAPACITY);
  if (_count == RAM_BUFFER_CAPACITY) {
    // Đầy: ghi đè bản ghi cũ nhất, luôn giữ dữ liệu mới nhất.
    _tail = (uint16_t)((_tail + 1) % RAM_BUFFER_CAPACITY);
  } else {
    _count++;
  }
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

void RingBuffer::pushFlash(const TelemetryRecord& rec) {
  if (!_mounted) {
    return;
  }
  File file = LittleFS.open(FLASH_QUEUE_PATH, "r+");
  if (!file) {
    return;
  }
  const uint32_t offset =
      sizeof(FlashQueueHeader) + (uint32_t)_flashHead * sizeof(TelemetryRecord);
  file.seek(offset);
  file.write((const uint8_t*)&rec, sizeof(rec));

  _flashHead = (uint16_t)((_flashHead + 1) % FLASH_BUFFER_CAPACITY);
  if (_flashCount < FLASH_BUFFER_CAPACITY) {
    _flashCount++;  // đầy thì ghi đè bản ghi cũ nhất (circular overwrite)
  }
  _writeFlashHeader(file);
  file.close();
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
  _flashCount--;
  File file = LittleFS.open(FLASH_QUEUE_PATH, "r+");
  if (!file) {
    return;
  }
  _writeFlashHeader(file);
  file.close();
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
  while (peek(rec)) {
    pushFlash(rec);
    pop();
  }
}
