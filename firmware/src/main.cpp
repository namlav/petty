#include <Arduino.h>

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
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

struct FeedingSchedule {
  bool enabled = false;
  uint8_t hour = 0;
  uint8_t minute = 0;
  float grams = FEED_TARGET_GRAMS;
  int32_t lastFiredSlot = -1;
} schedule;

float g_weight = 0;
uint8_t g_level = 0;
uint8_t g_error = ERR_NONE;
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
  rec.ts = nowTimestamp();
  rec.weight = g_weight;
  rec.level = g_level;
  rec.status = status;
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

void startFeeding(float grams, const char* source) {
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
  g_feeding = true;
  g_targetWeight = g_weight + grams;
  motor.startFeed();
  beepFeed();
  Serial.printf("[FEED] Bat dau (%s) muc tieu %.1f g\n", source,
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

// ---------------- Lịch hẹn giờ ----------------

void checkSchedule() {
  if (!schedule.enabled) {
    return;
  }
  const time_t now = time(nullptr);
  if (now < 1600000000) {
    return;  // chưa đồng bộ NTP
  }
  struct tm local;
  localtime_r(&now, &local);
  if (local.tm_hour != schedule.hour || local.tm_min != schedule.minute) {
    return;
  }
  const int32_t slot = (int32_t)(local.tm_yday * 24 + local.tm_hour) * 60 +
                       local.tm_min;
  if (slot == schedule.lastFiredSlot) {
    return;
  }
  schedule.lastFiredSlot = slot;
  startFeeding(schedule.grams, "schedule");
}

// ---------------- Nút bấm ----------------

void handleButtons() {
  static bool lastFeed = HIGH;
  static bool lastStop = HIGH;
  static bool lastDrop = HIGH;
  static uint32_t lockoutUntil = 0;

  const bool feed = digitalRead(PIN_BTN_FEED);
  const bool stop = digitalRead(PIN_BTN_STOP);
  const bool drop = digitalRead(PIN_BTN_WIFI_DROP);

  if (millis() > lockoutUntil) {
    if (lastFeed == HIGH && feed == LOW) {
      startFeeding(FEED_TARGET_GRAMS, "button");
      lockoutUntil = millis() + 250;
    } else if (lastStop == HIGH && stop == LOW) {
      stopFeeding("button");
      lockoutUntil = millis() + 250;
    } else if (lastDrop == HIGH && drop == LOW) {
      wsManager.toggleNetworkDrop();
      lockoutUntil = millis() + 400;
    }
  }

  lastFeed = feed;
  lastStop = stop;
  lastDrop = drop;
}

// ---------------- Lệnh từ Server ----------------

void handleCommands() {
  Command command;
  while (wsManager.popCommand(command)) {
    switch (command.type) {
      case CMD_FEED:
        startFeeding(command.grams, "remote");
        break;
      case CMD_STOP:
        stopFeeding("remote");
        break;
      case CMD_SET_SCHEDULE:
        schedule.enabled = command.enabled;
        schedule.hour = command.hour;
        schedule.minute = command.minute;
        schedule.grams = command.grams;
        schedule.lastFiredSlot = -1;
        Serial.printf("[SCHEDULE] %s %02u:%02u - %.1f g\n",
                      schedule.enabled ? "ON" : "OFF",
                      (unsigned)schedule.hour, (unsigned)schedule.minute,
                      (double)schedule.grams);
        break;
      case CMD_CLEAR_ERROR:
        g_error = ERR_NONE;
        motor.clearJam();
        Serial.println("[CMD] Xoa loi");
        break;
      default:
        break;
    }
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
  wsManager.begin(&ringBuffer);

  // Giờ Việt Nam (UTC+7) cho lịch hẹn ăn.
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");

  Serial.printf("[BOOT] Thiet bi %s san sang\n", DEVICE_ID);
}

void loop() {
  wsManager.update();
  handleCommands();
  handleButtons();

  static uint32_t lastSensorMs = 0;
  if (millis() - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = millis();
    g_weight = loadCell.update();
    if (g_weight < 0) {
      g_weight = 0;
    }
    g_level = readFoodLevel();
    if (g_error == ERR_EMPTY_TANK && g_level >= 10) {
      g_error = ERR_NONE;
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
