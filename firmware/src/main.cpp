#include <Arduino.h>

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Preferences.h>
#include <Wire.h>
#include <time.h>

#include "config.h"
#include "motor_control.h"
#include "packet_schema.h"
#include "ring_buffer.h"
#include "sensor_filter.h"
#include "ws_manager.h"

// ============================================================
// Điểm tích hợp SV1 (cảm biến + động cơ) và SV2 (mạng + buffer)
// ============================================================

Adafruit_SSD1306 display(128, 64, &Wire, -1);
SensorFilter loadCell;
MotorControl motor;
RingBuffer ringBuffer;
WsManager wsManager;
Preferences schedulePrefs;
bool schedulePrefsReady = false;

struct FeedingSchedule {
  bool enabled = false;
  uint8_t hour = 0;
  uint8_t minute = 0;
  float grams = FEED_TARGET_GRAMS;
  int32_t lastFiredSlot = -1;
} schedules[MAX_SCHEDULES];
uint8_t scheduleCount = 0;

float g_weight = 0;
uint8_t g_level = 0;
uint8_t g_error = ERR_NONE;
FeedSource g_feedSource = FEED_SRC_NONE;
uint32_t g_sequence = 0;
bool g_feeding = false;
float g_targetWeight = 0;

// ---------------- Tiện ích thời gian ----------------
uint32_t nowTimestamp() {
  const time_t t = time(nullptr);
  if (t > 1600000000) {
    return (uint32_t)t;
  }
  // Chưa có NTP: dùng mốc giả lập để vẫn có timestamp tăng dần.
  return (uint32_t)(1763040000UL + millis() / 1000UL);
}

// ---------------- Cảm biến mức hạt ----------------

float readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  const long duration = pulseIn(PIN_ECHO, HIGH, 30000);
  if (duration == 0) {
    return TANK_HEIGHT_CM;
  }
  return duration * 0.034f / 2.0f;
}

uint8_t readFoodLevel() {
  float distance = readDistanceCm();
  distance = constrain(distance, TANK_FULL_DISTANCE_CM, TANK_HEIGHT_CM);
  const float ratio = (TANK_HEIGHT_CM - distance) /
                      (TANK_HEIGHT_CM - TANK_FULL_DISTANCE_CM);
  return (uint8_t)constrain(ratio * 100.0f, 0.0f, 100.0f);
}

// ---------------- Âm thanh ----------------

void beepFeed() { tone(PIN_BUZZER, 1800, 120); }

void beepReject() { tone(PIN_BUZZER, 400, 300); }

void beepAlarm() {
  for (uint8_t i = 0; i < 3; i++) {
    tone(PIN_BUZZER, 2200, 150);
    delay(200);
  }
}

// ---------------- Telemetry ----------------

TelemetryRecord buildRecord(uint8_t status, uint8_t error) {
  TelemetryRecord rec{};
  rec.version = PROTOCOL_VERSION;
  rec.seq = ++g_sequence;
  if (schedulePrefsReady) {
    schedulePrefs.putUInt("seq", g_sequence);
  }
  rec.ts = nowTimestamp();
  rec.weight = g_weight;
  rec.level = g_level;
  // Hai bit cao mang FeedSource, vẫn giữ TelemetryRecord đúng 16 byte.
  rec.status = (status & 0x03) | ((uint8_t)g_feedSource << 2);
  rec.error = error;
  return rec;
}

uint8_t currentStatus() {
  if (g_error != ERR_NONE) return ST_ERROR;
  if (g_feeding) return ST_FEEDING;
  return ST_IDLE;
}

void publishEvent(uint8_t status, uint8_t error) {
  wsManager.publish(buildRecord(status, error));
}

// ---------------- Chu trình cho ăn ----------------

const char* feedSourceName(FeedSource source) {
  switch (source) {
    case FEED_SRC_MANUAL: return "manual";
    case FEED_SRC_SCHEDULE: return "schedule";
    case FEED_SRC_BUTTON: return "button";
    default: return "unknown";
  }
}

void startFeeding(float grams, FeedSource source) {
  if (g_feeding) {
    Serial.println("[FEED] Dang cho an, bo qua yeu cau");
    return;
  }
  if (g_weight > BOWL_FULL_GRAMS) {
    Serial.println("[FEED] Tu choi: bat an con day (chong tran)");
    beepReject();
    return;
  }
  if (g_level < 5) {
    Serial.println("[FEED] Tu choi: thung het hat");
    g_error = ERR_EMPTY_TANK;
    beepReject();
    publishEvent(ST_ERROR, ERR_EMPTY_TANK);
    return;
  }

  if (motor.isJammed()) {
    motor.clearJam();
  }
  g_error = ERR_NONE;
  g_feedSource = source;
  g_feeding = true;
  g_targetWeight = g_weight + grams;
  motor.startFeed();
  beepFeed();
  Serial.printf("[FEED] Bat dau (%s) muc tieu %.1f g\n", feedSourceName(source),
                (double)g_targetWeight);
  publishEvent(ST_FEEDING, ERR_NONE);
}

void finishFeeding(bool success) {
  g_feeding = false;
  motor.stop();
  if (success) {
    Serial.println("[FEED] Hoan tat chu trinh");
    publishEvent(ST_IDLE, ERR_NONE);
  }
}

void stopFeeding(const char* source) {
  if (!g_feeding) {
    return;
  }
  g_feeding = false;
  motor.stop();
  Serial.printf("[FEED] Dung khan cap (%s)\n", source);
  publishEvent(ST_IDLE, g_error);
}

void saveSchedulesToNvs() {
  if (!schedulePrefsReady) return;
  schedulePrefs.putUChar("count", scheduleCount);
  for (uint8_t i = 0; i < scheduleCount; ++i) {
    char key[8];
    snprintf(key, sizeof(key), "en%u", (unsigned)i);
    schedulePrefs.putBool(key, schedules[i].enabled);
    snprintf(key, sizeof(key), "h%u", (unsigned)i);
    schedulePrefs.putUChar(key, schedules[i].hour);
    snprintf(key, sizeof(key), "m%u", (unsigned)i);
    schedulePrefs.putUChar(key, schedules[i].minute);
    snprintf(key, sizeof(key), "g%u", (unsigned)i);
    schedulePrefs.putFloat(key, schedules[i].grams);
    snprintf(key, sizeof(key), "f%u", (unsigned)i);
    schedulePrefs.putInt(key, schedules[i].lastFiredSlot);
  }
}

void loadSchedulesFromNvs() {
  schedulePrefsReady = schedulePrefs.begin(NVS_NAMESPACE_SCHED, false);
  if (!schedulePrefsReady) {
    Serial.println("[SCHEDULE] Khong mo duoc NVS; dung lich RAM");
    return;
  }
  g_sequence = schedulePrefs.getUInt("seq", 0);
  scheduleCount = min(schedulePrefs.getUChar("count", 0), (uint8_t)MAX_SCHEDULES);
  for (uint8_t i = 0; i < scheduleCount; ++i) {
    char key[8];
    snprintf(key, sizeof(key), "en%u", (unsigned)i);
    schedules[i].enabled = schedulePrefs.getBool(key, false);
    snprintf(key, sizeof(key), "h%u", (unsigned)i);
    schedules[i].hour = min(schedulePrefs.getUChar(key, 0), (uint8_t)23);
    snprintf(key, sizeof(key), "m%u", (unsigned)i);
    schedules[i].minute = min(schedulePrefs.getUChar(key, 0), (uint8_t)59);
    snprintf(key, sizeof(key), "g%u", (unsigned)i);
    schedules[i].grams = constrain(schedulePrefs.getFloat(key, FEED_TARGET_GRAMS), 1.0f, 200.0f);
    snprintf(key, sizeof(key), "f%u", (unsigned)i);
    schedules[i].lastFiredSlot = schedulePrefs.getInt(key, -1);
  }
  Serial.printf("[SCHEDULE] Da nap %u lich tu NVS\n", (unsigned)scheduleCount);
}

// ---------------- Lịch hẹn giờ ----------------

void checkSchedule() {
  const time_t now = time(nullptr);
  if (now < 1600000000) {
    return;  // chưa đồng bộ NTP
  }
  struct tm local;
  localtime_r(&now, &local);
  for (uint8_t i = 0; i < scheduleCount; ++i) {
    FeedingSchedule& schedule = schedules[i];
    if (!schedule.enabled || local.tm_hour != schedule.hour ||
        local.tm_min != schedule.minute) continue;
    const int32_t slot = (int32_t)(((local.tm_year * 366L + local.tm_yday) * 24 +
                                     local.tm_hour) * 60 + local.tm_min);
    if (slot == schedule.lastFiredSlot) continue;
    schedule.lastFiredSlot = slot;
    if (schedulePrefsReady) {
      char key[8];
      snprintf(key, sizeof(key), "f%u", (unsigned)i);
      schedulePrefs.putInt(key, slot);
    }
    startFeeding(schedule.grams, FEED_SRC_SCHEDULE);
  }
}

// ---------------- Nút bấm ----------------

void handleButtons() {
  static bool lastFeed = HIGH;
  static bool lastStop = HIGH;
  static bool lastDrop = HIGH;
  static uint32_t lockoutUntil = 0;
  static uint32_t stopPressedAt = 0;
  static bool stopHoldHandled = false;

  const bool feed = digitalRead(PIN_BTN_FEED);
  const bool stop = digitalRead(PIN_BTN_STOP);
  const bool drop = digitalRead(PIN_BTN_WIFI_DROP);

  if (millis() > lockoutUntil) {
    if (lastFeed == HIGH && feed == LOW) {
      startFeeding(FEED_TARGET_GRAMS, FEED_SRC_BUTTON);
      lockoutUntil = millis() + 250;
    } else if (lastStop == HIGH && stop == LOW) {
      stopPressedAt = millis();
      stopHoldHandled = false;
      stopFeeding("button");
      lockoutUntil = millis() + 250;
    } else if (lastDrop == HIGH && drop == LOW) {
      wsManager.toggleNetworkDrop();
      lockoutUntil = millis() + 400;
    }
  }

  // Giữ nút STOP >= 3s khi không xả hạt để tare cân về 0g (T-SV1-03).
  if (stop == LOW && !g_feeding && !stopHoldHandled &&
      millis() - stopPressedAt >= 3000) {
    stopHoldHandled = true;
    loadCell.tare();
    beepFeed();
    Serial.println("[CAL] Giu STOP 3s -> Tare xong (0.0 g)");
  } else if (stop == HIGH) {
    stopHoldHandled = false;
  }

  lastFeed = feed;
  lastStop = stop;
  lastDrop = drop;
}

// ---------------- Lệnh Serial hiệu chuẩn (T-SV1-03) ----------------

void handleSerial() {
  static char buf[32];
  static size_t len = 0;
  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\r' || c == '\n') {
      if (len == 0) continue;
      buf[len] = '\0';
      len = 0;
      if (strcmp(buf, "tare") == 0) {
        loadCell.tare();
        Serial.println("[CAL] Tare xong (0.0 g)");
      } else if (strcmp(buf, "cal reset") == 0) {
        loadCell.resetCalibration();
        Serial.printf("[CAL] Reset ve mac dinh %.4f counts/g\n",
                      (double)loadCell.scale());
      } else if (strncmp(buf, "cal ", 4) == 0) {
        const float grams = (float)atof(buf + 4);
        if (loadCell.calibrate(grams)) {
          Serial.printf("[CAL] Hieu chuan %.1fg -> %.4f counts/g (da luu NVS)\n",
                        (double)grams, (double)loadCell.scale());
        } else {
          Serial.println("[CAL] Loi: nhap 'cal <gram>' > 0 khi da dat vat mau");
        }
      } else {
        Serial.println("[CAL] Lenh ho tro: tare | cal <gram> | cal reset");
      }
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = c;
    }
  }
}

// ---------------- Lệnh từ Server ----------------

void handleCommands() {
  Command command;
  while (wsManager.popCommand(command)) {
    bool ok = true;
    switch (command.type) {
      case CMD_FEED:
        if (!command.expired) startFeeding(command.grams, FEED_SRC_MANUAL);
        break;
      case CMD_STOP:
        stopFeeding("remote");
        break;
      case CMD_SET_SCHEDULE:
        scheduleCount = 1;
        schedules[0].enabled = command.enabled;
        schedules[0].hour = command.hour;
        schedules[0].minute = command.minute;
        schedules[0].grams = command.grams;
        schedules[0].lastFiredSlot = -1;
        saveSchedulesToNvs();
        Serial.printf("[SCHEDULE] %s %02u:%02u - %.1f g\n",
                      schedules[0].enabled ? "ON" : "OFF",
                      (unsigned)schedules[0].hour, (unsigned)schedules[0].minute,
                      (double)schedules[0].grams);
        break;
      case CMD_SET_SCHEDULES:
        scheduleCount = min(command.scheduleCount, (uint8_t)MAX_SCHEDULES);
        for (uint8_t i = 0; i < scheduleCount; i++) {
          schedules[i].enabled = command.schedules[i].enabled;
          schedules[i].hour = command.schedules[i].hour;
          schedules[i].minute = command.schedules[i].minute;
          schedules[i].grams = command.schedules[i].grams;
          schedules[i].lastFiredSlot = -1;
        }
        saveSchedulesToNvs();
        Serial.printf("[SCHEDULE] Dong bo %u lich\n", (unsigned)scheduleCount);
        break;
      case CMD_CLEAR_ERROR:
        g_error = ERR_NONE;
        motor.clearJam();
        Serial.println("[CMD] Xoa loi");
        break;
      default:
        ok = false;
        break;
    }
    wsManager.ackCommand(command.cid, ok);
  }
}

// ---------------- Hiển thị ----------------

const char* wsStateText() {
  switch (wsManager.state()) {
    case STATE_ONLINE_NORMAL:
      return "ONLINE";
    case STATE_RECONNECTED_SYNCING:
      return "SYNCING";
    default:
      return "OFFLINE";
  }
}

const char* errorText() {
  switch (g_error) {
    case ERR_JAM:
      return "JAM";
    case ERR_EMPTY_TANK:
      return "EMPTY";
    case ERR_SENSOR_FAULT:
      return "SENSOR";
    default:
      return "OK";
  }
}

void updateDisplay() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);

  display.setCursor(0, 0);
  display.print("PET FEEDER IOT");
  display.drawLine(0, 10, 127, 10, WHITE);

  display.setCursor(0, 16);
  display.printf("Bowl: %.1f g", (double)g_weight);
  display.setCursor(0, 26);
  display.printf("Tank: %u %%", (unsigned)g_level);

  display.setCursor(0, 38);
  display.printf("WS: %s Q:%u", wsStateText(),
                 (unsigned)wsManager.pendingCount());

  display.setCursor(0, 50);
  display.printf("Err: %s", errorText());
  display.display();
}

void updateLeds() {
  const bool online = wsManager.isConnected();
  const bool blink = (millis() / 500) % 2 == 0;
  digitalWrite(PIN_LED_GREEN, online ? HIGH : (blink ? HIGH : LOW));
  digitalWrite(PIN_LED_RED,
               (g_error != ERR_NONE || g_level < LOW_FOOD_PERCENT) ? HIGH : LOW);
}

// ---------------- Task điều khiển động cơ ----------------
// Đọc HX711/pulseIn có thể block vài chục ms; step phải đều để timeout 2.5s
// và phản hồi LIMIT_SW chính xác, nên tách sang task riêng.
void motorLoopTask(void* parameter) {
  (void)parameter;
  for (;;) {
    motor.update();
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

// ---------------- setup / loop ----------------

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Pet Feeder IoT (SV1 + SV2) ===");

  pinMode(PIN_BTN_FEED, INPUT_PULLUP);
  pinMode(PIN_BTN_STOP, INPUT_PULLUP);
  pinMode(PIN_BTN_WIFI_DROP, INPUT_PULLUP);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, LOW);

  Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    display.clearDisplay();
    display.setTextColor(WHITE);
    display.setCursor(15, 25);
    display.print("PET FEEDER IOT");
    display.display();
  } else {
    Serial.println("[OLED] Khoi tao that bai");
  }

  loadCell.begin();
  motor.begin();
  xTaskCreatePinnedToCore(motorLoopTask, "motor", 4096, nullptr, 2, nullptr, 1);
  ringBuffer.begin();
  loadSchedulesFromNvs();
  wsManager.begin(&ringBuffer);

  // Giờ Việt Nam (UTC+7) cho lịch hẹn ăn.
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");

  Serial.printf("[BOOT] Thiet bi %s san sang\n", DEVICE_ID);
}

void loop() {
  wsManager.update();
  handleCommands();
  handleButtons();
  handleSerial();

  static uint32_t lastSensorMs = 0;
  if (millis() - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = millis();
    g_weight = loadCell.update();
    if (g_weight < 0) {
      g_weight = 0;
    }
    g_level = readFoodLevel();

    if (loadCell.isFaulty()) {
      if (g_error != ERR_SENSOR_FAULT) {
        g_error = ERR_SENSOR_FAULT;
        beepAlarm();
        Serial.println("[ALERT] ERR_SENSOR_FAULT - HX711 khong phan hoi");
        publishEvent(ST_ERROR, ERR_SENSOR_FAULT);
      }
    } else {
      if (g_error == ERR_SENSOR_FAULT) {
        g_error = ERR_NONE;
      }
      if (g_level < 5 && g_error == ERR_NONE) {
        g_error = ERR_EMPTY_TANK;
        beepReject();
        Serial.println("[ALERT] ERR_EMPTY_TANK - thung het hat");
        publishEvent(ST_ERROR, ERR_EMPTY_TANK);
      } else if (g_error == ERR_EMPTY_TANK && g_level >= 10) {
        g_error = ERR_NONE;
      }
    }
  }

  // Sự kiện kẹt hạt do SV1 phát sang SV2.
  if (motor.consumeJamEvent()) {
    g_feeding = false;
    g_error = ERR_JAM;
    Serial.println("[ALERT] ERR_JAM - da ngat dong co");
    beepAlarm();
    publishEvent(ST_ERROR, ERR_JAM);
  }

  if (g_feeding) {
    if (!motor.isFeeding() && !motor.isJammed()) {
      finishFeeding(true);  // LIMIT_SW báo hoàn tất một chu kỳ
    } else if (g_weight >= g_targetWeight) {
      finishFeeding(true);  // đủ khẩu phần theo loadcell
    }
  }

  checkSchedule();

  static uint32_t lastTelemetryMs = 0;
  if (millis() - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = millis();
    publishEvent(currentStatus(), g_error);
  }

  static uint32_t lastDisplayMs = 0;
  if (millis() - lastDisplayMs >= 500) {
    lastDisplayMs = millis();
    updateDisplay();
    updateLeds();
  }
}
