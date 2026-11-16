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
#define LOW_FOOD_HYSTERESIS_PERCENT 25

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

// ---------- Ngưỡng cơ khí & NVS (SV1) ----------
#define FEED_TARGET_GRAMS 30.0f   // khẩu phần mặc định
#define BOWL_FULL_GRAMS 120.0f    // chống tràn
#define SENSOR_INTERVAL_MS 200
#define TELEMETRY_INTERVAL_MS 5000
#define MAX_SCHEDULES 4
#define NVS_NAMESPACE_SCHED "petty-sched"
#define NVS_NAMESPACE_CAL "petty-cal"
#define NVS_NAMESPACE_CMD "petty-cmd"

// ---------- Mạng & WebSocket (SV2) ----------
// Wokwi ESP32 dùng WiFi ảo Wokwi-GUEST (không mật khẩu).
#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_PASSWORD ""
// Với Wokwi VS Code: "host.wokwi.internal" là hostname DNS có sẵn của Wokwi trỏ về localhost máy tính.
// Với phần cứng thật / deploy Cloud: truyền -D WS_HOST=\"...\" trong platformio.ini hoặc sửa tại đây.
#ifndef WS_HOST
#ifdef PETTY_USE_WOKWI_PRIVATE_GW
#define WS_HOST "host.wokwi.internal"
#else
#define WS_HOST "target"
#endif
#endif

// Bật -D PETTY_TLS=1 khi kết nối Gateway HTTPS/WSS (port 443) trên Render/Koyeb.
#ifndef PETTY_TLS
#define PETTY_TLS 0
#endif

#ifndef PETTY_PRODUCTION
#define PETTY_PRODUCTION 0
#endif

#if PETTY_PRODUCTION && !PETTY_TLS
#error "Production firmware requires TLS (PETTY_TLS=1)"
#endif

#if PETTY_PRODUCTION && !defined(DEVICE_TOKEN)
#error "Production firmware requires a per-device DEVICE_TOKEN"
#endif

#if PETTY_PRODUCTION && (!defined(WS_HOST) || !defined(PETTY_ROOT_CA))
#error "Production firmware requires WS_HOST and PETTY_ROOT_CA"
#endif

#if PETTY_TLS && !defined(PETTY_ROOT_CA)
#error "PETTY_TLS requires PETTY_ROOT_CA so the Gateway certificate is verified"
#endif

#ifndef WS_PORT
#if PETTY_TLS
#define WS_PORT 443
#else
#define WS_PORT 8080
#endif
#endif

#define WS_PATH "/ws?role=device"
#define DEVICE_ID "esp01"
#ifndef DEVICE_TOKEN
#if PETTY_PRODUCTION
#error "Set DEVICE_TOKEN for production firmware"
#else
#define DEVICE_TOKEN "dev-device-token"
#endif
#endif
#define CMD_DEDUP_WINDOW 8

#define WS_HEARTBEAT_INTERVAL_MS 10000
#define WS_ACK_TIMEOUT_MS 3000
#define BACKOFF_BASE_MS 1000
#define BACKOFF_MAX_MS 30000
#define WIFI_RETRY_INTERVAL_MS 10000
