# 🐾 Petty — Hệ thống Cho Thú Cưng Ăn Tự Động (IoT)

Monorepo 4 phân hệ phục vụ Đề tài 7 (kiến trúc 4 tầng IoT): **Firmware ESP32 (PlatformIO + Wokwi)**, **WebSocket Gateway (Node.js)**, **100% Firebase Spark (Firestore + Auth + FCM)** và **Ứng dụng giám sát (Flutter Mobile App + Web Dashboard)**.

```
┌──────────────┐   WS / WSS (compact JSON)   ┌────────────────────┐   Firebase Admin SDK   ┌──────────────────┐
│ ESP32/Wokwi  │ ──────────────────────────► │ backend-ws-gateway │ ─────────────────────► │ Firebase (Spark) │
│  SV1 + SV2   │ ◄─── {"ack":s} / {"cack"} ─ │  firebase · auth   │                        │  Cloud Firestore │
│ Ring Buffer  │                             │  alerts · notify   │ ───► FCM HTTP v1 ─┐    │  Auth + Rules    │
└──────────────┘                             └─────────┬──────────┘                   │    └──────────────────┘
                                                       │ broadcast WS                 ▼
                                                       ▼                     ┌─────────────────┐
                                             ┌────────────────────┐          │   mobile-app    │
                                             │   dashboard-app    │          │  Flutter + Dart │
                                             │   Chart.js + WS    │          │  fl_chart + FCM │
                                             └────────────────────┘          └─────────────────┘
```

> Xem đặc tả kiến trúc chi tiết (sơ đồ 4 tầng, bảng linh kiện, thiết kế 100% Firebase Spark, giao thức & RBAC) tại [docs/architecture.md](docs/architecture.md).

---

## 1. Cấu trúc thư mục

```
petty/
├── .vscode/                        # Gợi ý extension (PlatformIO, Wokwi, Flutter) & include path
├── petty.code-workspace            # Multi-root workspace (Root, Firmware, Gateway, Flutter)
├── docs/
│   └── architecture.md             # [NHÓM] Đặc tả kiến trúc 4 tầng & bảng linh kiện (Câu 1)
├── firmware/                       # [SV1 + SV2] PlatformIO project (ESP32)
│   ├── include/                    # config.h, packet_schema.h, ring_buffer.h, ws_manager.h,
│   │                               # sensor_filter.h, motor_control.h
│   ├── src/                        # main.cpp + 4 module .cpp
│   ├── data/                       # Phân vùng LittleFS (.keep)
│   ├── diagram.json                # Sơ đồ Wokwi (HX711, A4988 + stepper, HC-SR04, OLED, nút, LED)
│   ├── platformio.ini
│   └── wokwi.toml                  # Full merged image + Private IoT Gateway
├── backend-ws-gateway/             # [SV2 + SV3] Node.js WebSocket & REST Gateway
│   ├── server.js                   # Express REST API, WebSocket relay, Firestore sync & 60s sweep
│   ├── firebase.js                 # [SV3] Lazy-init firebase-admin (Firestore, Auth, Messaging)
│   ├── auth.js                     # [SV3/SV2] Firebase ID Token / HS256 JWT, RBAC & device auth
│   ├── alerts.js                   # [SV2] Alert engine (LOW_FOOD/JAM/EMPTY/OFFLINE) & feeding events
│   ├── notify.js                   # [SV3] Firebase Cloud Messaging (FCM) + chế độ demo
│   ├── package.json
│   └── .env.example
├── cloud-database/                 # [SV3] Cloud Firestore & Security Rules (Spark Free Tier)
│   ├── firestore_schema.md         # Đặc tả Collections, chống trùng telemetry & stats_hourly/daily
│   ├── firestore.indexes.json      # Composite indexes cho Firestore queries
│   └── firestore.rules             # Firestore Security Rules: admin / owner / viewer / backend
├── dashboard-app/                  # [SV3] Web Dashboard dự phòng (Chart.js + WS)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── mobile-app/                     # [SV3] Mobile App Flutter (Android / iOS / Web)
│   ├── pubspec.yaml
│   ├── android/app/google-services.json.example
│   ├── lib/
│   │   ├── config.dart             # FIREBASE_PROJECT_ID, FIREBASE_WEB_API_KEY, GATEWAY_* (--dart-define)
│   │   ├── models/                 # telemetry.dart, device.dart, schedule.dart, alert.dart
│   │   ├── services/               # auth_service, gateway_service, history_service, push_service
│   │   ├── state/                  # app_state.dart (Provider)
│   │   ├── screens/                # login, dashboard, schedules, statistics, alerts, settings
│   │   └── main.dart
│   └── test/widget_test.dart
└── README.md
```

---

## 2. Yêu cầu môi trường

| Thành phần | Phiên bản / Ghi chú |
|---|---|
| VS Code | Extension **PlatformIO IDE**, **Wokwi for VS Code**, **Flutter** (`.vscode/extensions.json`) |
| PlatformIO Core | 6.x |
| Node.js | ≥ 18 (đã kiểm thử trên Node 25) |
| Flutter SDK | ≥ 3.11 (Dart ≥ 3.11) |
| Firebase (Spark) | Cloud Firestore + Firebase Auth + FCM (`petty-68437`) — tuỳ chọn khi chạy demo cục bộ |

---

## 3. Chạy WebSocket Gateway (`backend-ws-gateway/`)

```powershell
cd backend-ws-gateway
npm install
# Nếu kết nối Firebase thật (Service Account JSON), cài thêm firebase-admin:
# npm install firebase-admin
Copy-Item .env.example .env      # tuỳ chọn, điền FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT / JWT_SECRET
npm start
```

* Gateway lắng nghe `http://localhost:8080`, WebSocket tại `ws://localhost:8080/ws`.
* Web Dashboard dự phòng: <http://localhost:8080/index.html>.
* REST API chính: `GET /api/health`, `GET /api/devices`, `GET /api/telemetry`, `GET /api/stats`, `POST /api/feed`, `POST /api/stop`, `GET/PUT /api/schedules`, `GET /api/alerts`, `POST /api/fcm-token`.
* Khi chưa đặt `JWT_SECRET` và chưa cấu hình `FIREBASE_SERVICE_ACCOUNT` trong `NODE_ENV=development`, gateway chạy **demo mode** (lưu RAM, `[FCM:DEMO]`, mặc định `admin`). Khi đặt `JWT_SECRET`, gateway in ra 3 token mẫu `admin / owner / viewer` lúc khởi động.

---

## 4. Build & chạy Firmware ESP32 (`firmware/`)

```powershell
cd firmware
pio run                 # build firmware
pio run -t upload       # nạp board thật (nếu có)
```

### Chạy Wokwi Simulator

1. Mở thư mục `firmware/` hoặc file `petty.code-workspace` bằng VS Code.
2. Build môi trường mô phỏng để tạo full image (gồm bootloader, partition table và LittleFS): `pio run -e wokwi`.
3. `Ctrl+Shift+P` → **Wokwi: Start Simulator**.
4. Bật Gateway local trước khi khởi động mô phỏng. Môi trường `wokwi` kết nối `host.wokwi.internal:8080` qua Wokwi Private IoT Gateway; chọn **Enable Private Wokwi IoT Gateway** trong VS Code. Build `wokwi` luôn gửi token trong header và dùng đường dẫn WebSocket không chứa token. Tài khoản chỉ có Public Gateway vẫn chạy mô phỏng nhưng không truy cập được dịch vụ trên máy host. `net.forward` chuyển kết nối từ host vào ESP32, không thay thế được kết nối do ESP32 khởi tạo. Nếu Gateway chỉ bind loopback mà Wokwi không truy cập được, đặt `HOST=0.0.0.0` khi chạy Gateway và giới hạn truy cập bằng firewall. Khi nạp board thật, đặt `PETTY_WS_HOST` thành hostname Gateway.
5. Firmware luôn gửi token qua header `Authorization: Bearer ...` và ID qua `X-Device-ID`. Ở production, Gateway chỉ nhận token header và đối chiếu SHA-256 với `device_credentials/{device_id}.token_hash` trong Firestore. Để tạo hash, đưa token vào stdin của `node backend-ws-gateway/scripts/hash-device-token.js` rồi lưu kết quả vào document tương ứng.
6. Build WSS production bằng môi trường riêng; script đọc host, token và CA PEM từ environment, nên không cần đặt bí mật vào `platformio.ini`:

```powershell
$env:PETTY_WS_HOST = "gateway.example.com"
$env:PETTY_DEVICE_TOKEN = "<token-riêng-của-thiết-bị>"
$env:PETTY_ROOT_CA_FILE = "C:\certs\root-ca.pem"
pio run -e production
```

`production` bật TLS bắt buộc, kiểm tra chứng thư bằng CA với `beginSslWithCA`, và dừng build nếu thiếu host, token hoặc CA. Token được nhúng trong firmware image, vì vậy mỗi thiết bị cần token riêng và image cần được giữ kín.

### Sơ đồ chân (khớp `firmware/diagram.json`)

| Linh kiện | Chân ESP32 |
|---|---|
| HX711 loadcell khay ăn (`5kg`) | `DT` → 16, `SCK` → 4 |
| A4988 + stepper xả hạt | `STEP` → 19, `DIR` → 23, `ENABLE` → 18 |
| Limit switch chống kẹt | 32 (`INPUT_PULLUP`, nhấn = LOW) |
| HC-SR04 mức hạt | `TRIG` → 5, `ECHO` → 17 |
| OLED SSD1306 I2C | `SDA` → 21, `SCL` → 22 |
| Nút FEED / STOP / WIFI_DROP | 25 / 26 / 33 |
| Buzzer / LED xanh / LED đỏ | 27 / 14 / 13 |

---

## 5. Thiết lập 100% Firebase Spark (`cloud-database/`)

1. Mở Firebase Project gói **Spark** (`petty-68437`) tại Firebase Console → bật **Cloud Firestore** (Production mode) và **Authentication** (Email/Password).
2. Triển khai Security Rules và Composite Indexes từ thư mục `cloud-database/`:
   - `cloud-database/firestore.rules` (phân quyền RBAC `admin`, `owner`, `viewer`)
   - `cloud-database/firestore.indexes.json` (7 composite index cho telemetry, schedules, commands, alerts, stats)
   - Tham khảo chi tiết schema và cơ chế tiết kiệm quota Spark tại `cloud-database/firestore_schema.md`.
3. Tạo khóa Service Account JSON tại **Project Settings → Service Accounts → Generate new private key**, lưu vào `backend-ws-gateway/secrets/fcm-service-account.json` (đã ignore trong `.gitignore`).
4. Trong `backend-ws-gateway/`, cài `npm install firebase-admin`, rồi điền `FIREBASE_PROJECT_ID=petty-68437` và `FIREBASE_SERVICE_ACCOUNT=./secrets/fcm-service-account.json` vào `backend-ws-gateway/.env`. Cơ chế quét thiết bị offline (60s) chạy trực tiếp trong Gateway mà không cần Cloud Functions (gói Blaze).
5. Khi deploy production, tạo `device_credentials/{device_id}` trong Firestore với `token_hash` là SHA-256 (hex chữ thường) của token thiết bị. Firmware gửi token bằng `Authorization` và ID bằng `X-Device-ID`; raw token không được lưu trong Firestore.

---

## 6. Chạy Mobile App Flutter (`mobile-app/`)

```powershell
cd mobile-app
flutter pub get
flutter analyze
flutter test
flutter run --dart-define=GATEWAY_HTTP_URL=http://10.0.2.2:8080 --dart-define=GATEWAY_WS_URL=ws://10.0.2.2:8080/ws
```

* Để đăng nhập Firebase Auth thật (thay vì demo mode), truyền thêm `--dart-define=FIREBASE_WEB_API_KEY=<Web_API_Key>`.
* Khi chạy trên **Android Emulator**, `10.0.2.2` trỏ về `localhost` của máy tính (đã đặt làm mặc định trong `mobile-app/lib/config.dart`).
* Khi chạy **Chrome / Windows / thiết bị thật**, truyền `--dart-define=GATEWAY_HTTP_URL=http://<IP_LAN>:8080` hoặc sửa trực tiếp tại tab **Cài đặt** trong app.
* Để bật **Firebase Messaging** trên Android, copy `mobile-app/android/app/google-services.json.example` thành `google-services.json` theo cấu hình Firebase Project và bỏ comment các dependency Firebase trong `pubspec.yaml`.

---

## 7. Ghi chú kỹ thuật & Phân công file

* **Bộ lọc SV1:** median cửa sổ 5 → EMA `α = 0.25`; ổn định khi biên độ 5 mẫu $< 1.0\text{ g}$. Driver **A4988 + NEMA 17** được chọn để đủ mô-men xoắn và ngắt dòng qua `ENABLE` khi kẹt (`docs/architecture.md` §3.1).
* **Gói tin & Buffer SV2:** `TelemetryRecord` packed **16 byte**, Compact JSON kèm ACK/CACK; Ring Buffer 2 tầng (RAM 64 gói + LittleFS 500 gói).
* **Phân công file (tránh xung đột Git):**

| Thành viên | Phụ trách |
|---|---|
| **SV1** | `firmware/src/sensor_filter.cpp`, `firmware/src/motor_control.cpp`, `firmware/include/sensor_filter.h`, `firmware/include/motor_control.h`, `firmware/src/main.cpp` (lịch NVS, hiệu chuẩn), `firmware/diagram.json` |
| **SV2** | `firmware/include/packet_schema.h`, `ring_buffer.*`, `ws_manager.*`, `backend-ws-gateway/server.js` (luồng lệnh `cack`, trạng thái online), `backend-ws-gateway/alerts.js` |
| **SV3** | `cloud-database/firestore.rules`, `cloud-database/firestore.indexes.json`, `cloud-database/firestore_schema.md`, `backend-ws-gateway/firebase.js`, `backend-ws-gateway/auth.js`, `backend-ws-gateway/notify.js`, `mobile-app/*`, `dashboard-app/*` |
| **NHÓM** | `docs/architecture.md`, `README.md` |
