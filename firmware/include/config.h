#pragma once

// ============================================================
// Cấu hình chung cho toàn bộ firmware (SV1 + SV2)
// Chân GPIO khớp 100% với firmware/diagram.json (Wokwi)
// ============================================================

// ---------- Cảm biến khối lượng khay ăn (HX711) ----------
#define PIN_HX711_DOUT 16
#define PIN_HX711_SCK 4
// Wokwi HX711 type "5kg": raw 0..2100 tương ứng 0..5000 g => 0.42 count/g
// Hiệu chuẩn lại với loadcell thật: counts_per_gram = raw / khối lượng đã biết (g)
#define HX711_COUNTS_PER_GRAM 0.42f

// ---------- Động cơ bước xả hạt (A4988) ----------
#define PIN_STEP 19
#define PIN_DIR 23
#define PIN_ENABLE 18
#define PIN_LIMIT_SW 32
#define STEPPER_STEPS_PER_REV 200
#define STEPPER_MAX_SPEED 800   // steps/s
#define STEPPER_ACCEL 400       // steps/s^2
#define RETRACT_STEPS 33        // ~60 do (200 steps/vong)
#define FEED_TIMEOUT_MS 2500
#define MAX_RETRY 3

// ---------- Cảm biến mức hạt (HC-SR04) ----------
#define PIN_TRIG 5
#define PIN_ECHO 17
#define TANK_HEIGHT_CM 30.0f
#define TANK_FULL_DISTANCE_CM 4.0f
#define LOW_FOOD_PERCENT 15

// ---------- Màn hình / nút bấm / cảnh báo ----------
#define PIN_OLED_SDA 21
#define PIN_OLED_SCL 22
#define PIN_BTN_FEED 25
#define PIN_BTN_STOP 26
#define PIN_BTN_WIFI_DROP 33
#define PIN_BUZZER 27
#define PIN_LED_GREEN 14
#define PIN_LED_RED 13

// ---------- Bộ lọc số (SV1) ----------
#define FILTER_MEDIAN_WINDOW 5
#define FILTER_EMA_ALPHA 0.25f
#define FILTER_STABLE_SAMPLES 5
#define FILTER_STABLE_THRESHOLD_G 1.0f

// ---------- Ngưỡng cơ khí ----------
#define FEED_TARGET_GRAMS 30.0f   // khẩu phần mặc định
#define BOWL_FULL_GRAMS 120.0f    // chống tràn
#define SENSOR_INTERVAL_MS 200
#define TELEMETRY_INTERVAL_MS 5000

// ---------- Mạng & WebSocket (SV2) ----------
// Wokwi ESP32 dùng WiFi ảo Wokwi-GUEST (không mật khẩu).
#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_PASSWORD ""
// Wokwi Private IoT Gateway ánh xạ máy tính thành host.wokwi.internal.
// Với phần cứng thật: đổi thành IP LAN của máy chạy backend-ws-gateway.
#define WS_HOST "host.wokwi.internal"
#define WS_PORT 8080
#define WS_PATH "/ws?role=device&token=dev-device-token"
#define DEVICE_ID "esp01"

#define WS_HEARTBEAT_INTERVAL_MS 10000
#define WS_ACK_TIMEOUT_MS 3000
#define BACKOFF_BASE_MS 1000
#define BACKOFF_MAX_MS 30000
#define WIFI_RETRY_INTERVAL_MS 10000
