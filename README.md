# 🐾 Petty — Hệ thống Cho Thú Cưng Ăn Tự Động (IoT)

Monorepo 3 phân hệ cho 3 thành viên: **firmware ESP32 (PlatformIO + Wokwi)**, **WebSocket Gateway (Node.js)** và **Cloud + Dashboard (Supabase/PostgreSQL + Chart.js)**.

```
┌──────────────┐   WebSocket (compact JSON)   ┌────────────────────┐   REST/PostgREST   ┌──────────────┐
│ ESP32/Wokwi  │ ───────────────────────────► │ backend-ws-gateway │ ─────────────────► │   Supabase   │
│  SV1 + SV2   │ ◄───────── {"ack":seq} ───── │  Node.js + ws      │                    │  PostgreSQL  │
│ Ring Buffer  │                              │  JWT + RBAC        │                    │  RLS + cron  │
└──────────────┘                              └─────────┬──────────┘                    └──────────────┘
                                                        │ broadcast WS
                                                        ▼
                                              ┌────────────────────┐
                                              │  dashboard-app     │
                                              │  Chart.js + WS     │
                                              └────────────────────┘
```

## 1. Cấu trúc thư mục

```
petty/
├── .vscode/                  # Gợi ý extension + cấu hình include path
├── firmware/                 # [SV1 + SV2] PlatformIO project (ESP32)
│   ├── include/              # config.h, packet_schema.h, ring_buffer.h, ws_manager.h,
│   │                         # sensor_filter.h, motor_control.h
│   ├── src/                  # main.cpp + 4 module .cpp
│   ├── data/                 # Phân vùng LittleFS (chứa .keep)
│   ├── diagram.json          # Sơ đồ Wokwi (HX711, A4988 + stepper, HC-SR04, OLED, nút, LED)
│   ├── platformio.ini
│   └── wokwi.toml            # Build path + Wokwi full-flash configuration
├── backend-ws-gateway/       # [SV2 + SV3] WebSocket server
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── cloud-database/           # [SV3]
│   ├── schema.sql            # devices, feeding_schedules, telemetry_logs, device_commands, pg_cron
│   └── rls_rbac_policies.sql # RLS: admin / owner / viewer / device
├── dashboard-app/            # [SV3]
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── README.md
```

## 2. Yêu cầu môi trường

| Thành phần | Phiên bản / Ghi chú |
|---|---|
| VS Code | extension **PlatformIO IDE** + **Wokwi for VS Code** (đã khai báo trong `.vscode/extensions.json`) |
| PlatformIO Core | 6.x (VS Code extension tự cài) |
| Node.js | ≥ 18 (đã test với Node 25) |
| Tài khoản Wokwi | Bản miễn phí đủ dùng cho `diagram.json` |
| Supabase | Free tier (tuỳ chọn — gateway vẫn chạy in-memory nếu chưa cấu hình) |

## 3. Chạy WebSocket Gateway

```powershell
cd backend-ws-gateway
npm install
Copy-Item .env.example .env      # tuỳ chọn, sửa JWT_SECRET / DEVICE_TOKEN / Supabase
npm start
```

Gateway lắng nghe `http://localhost:8080`:

* `ws://localhost:8080/ws?role=device&token=<DEVICE_TOKEN>` — ESP32
* `ws://localhost:8080/ws?role=dashboard&token=<JWT>` — dashboard
* Dashboard tĩnh: <http://localhost:8080/index.html>
* REST: `POST /api/feed`, `POST /api/stop`, `POST /api/schedule`, `GET /api/telemetry`, `GET /api/health`

Khi chưa đặt `JWT_SECRET`, gateway chạy **demo mode** (mọi dashboard là `admin`, không cần token). Khi đặt `JWT_SECRET`, gateway in ra 3 token demo `admin / owner / viewer` lúc khởi động — dán token tương ứng vào ô **JWT token** trên dashboard.

Luồng xử lý mỗi gói tin: nhận compact JSON → **ACK ngay** `{"ack": seq}` → chống trùng theo `(device_id, seq_num)` → broadcast dashboard → upsert Supabase (nếu cấu hình).

## 4. Build & chạy firmware

```powershell
cd firmware
pio run                 # build
pio run -t upload       # nạp board thật (nếu có)
```

### Chạy Wokwi Simulator

1. Mở thư mục `firmware/` bằng VS Code (PlatformIO tự nhận project).
2. Build trước để có `.pio/build/esp32dev/firmware.bin` / `.elf`.
3. `Ctrl+Shift+P` → **Wokwi: Start Simulator** (hoặc bấm icon Wokwi trên thanh trạng thái).
4. Bật backend gateway trước khi khởi động mô phỏng. Để ESP32 trong Wokwi kết nối tới localhost, cần bật **Wokwi Private IoT Gateway**.

ESP32 trong Wokwi dùng Wi-Fi ảo `Wokwi-GUEST`; với Private IoT Gateway, firmware kết nối `ws://host.wokwi.internal:8080/ws` (xem `firmware/include/config.h`). Public Gateway không truy cập được dịch vụ localhost. Với phần cứng thật, đổi `WS_HOST` thành IP LAN của máy chạy gateway và cập nhật `WS_PATH`/`DEVICE_TOKEN` nếu cần.

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

## 5. Demo chấm điểm (gợi ý kịch bản)

1. **Online bình thường:** bật gateway → chạy Wokwi → dashboard hiện `ONLINE`, telemetry 5 s/gói, biểu đồ cập nhật.
2. **Cho ăn từ xa:** nhập khẩu phần → **Cho ăn ngay** → ESP32 quay stepper; bấm **LIMIT_SW** trên Wokwi để kết thúc chu kỳ.
3. **Chống kẹt:** không bấm `LIMIT_SW` → sau 2.5 s động cơ lùi 60° và thử lại 3 lần → `ERR_JAM`, ngắt `ENABLE`, hú còi, dashboard hiện `ERROR · Jammed`.
4. **Mất mạng + đồng bộ:** bấm **WIFI_DROP** → dashboard chuyển `OFFLINE BUFFERING`, bộ đếm Ring Buffer tăng; bấm lại **WIFI_DROP** → ESP32 gửi bù FIFO với `"st":2`, dashboard hiện `SYNCING` và log nguồn `SYNC` cho tới khi bộ đếm về 0.
5. **RBAC:** đặt `JWT_SECRET` trong `.env`, dùng token `viewer` → nút điều khiển bị từ chối `403`; token `owner`/`admin` điều khiển được.

## 6. Supabase (tuỳ chọn)

1. Tạo project Supabase (free) → mở **SQL Editor**.
2. Chạy lần lượt `cloud-database/schema.sql` rồi `cloud-database/rls_rbac_policies.sql`.
3. Bật extension `pg_cron` (Database → Extensions) nếu muốn lịch ăn tự động chạy phía cloud.
4. Điền `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` vào `backend-ws-gateway/.env` rồi khởi động lại gateway.

`telemetry_logs` có `UNIQUE(device_id, seq_num)` nên các gói ESP32 gửi bù từ Ring Buffer không bị ghi trùng. `pg_cron` quét `feeding_schedules` mỗi phút và đẩy lệnh `FEED` vào `device_commands`.

## 7. Ghi chú kỹ thuật

* **Bộ lọc SV1:** median cửa sổ 5 → EMA `α = 0.25`; xác nhận ổn định khi max-min của 5 mẫu < 1.0 g.
* **Gói tin SV2:** `TelemetryRecord` packed **16 byte** (lưu RAM/Flash), JSON rút gọn khi truyền. Trường `q` (tuỳ chọn) báo số gói còn trong buffer để dashboard hiển thị.
* **Lưu bền hai chặng:** ESP32 giữ ring buffer RAM 64 bản ghi và LittleFS 500 bản ghi khi offline; Gateway ghi telemetry vào JSONL spool và `fsync` trước ACK. Gateway tự gửi FIFO lên Supabase và giữ bản ghi pending khi cloud lỗi. Queue ESP32 đầy thì từ chối gói mới thay vì ghi đè gói chưa ACK.
* **Backoff:** `min(1 s × 2ⁿ, 30 s)`, heartbeat WebSocket 10 s.
* **Lịch hẹn:** lưu trong RAM thiết bị (mất khi reboot) và được đồng bộ lại từ dashboard/gateway khi có kết nối; bản lưu bền nằm ở bảng `feeding_schedules`.
* **Hiệu chuẩn loadcell:** sửa `HX711_COUNTS_PER_GRAM` trong `config.h` (`raw / khối lượng đã biết`), và tare khi khay rỗng.
* **Thời gian:** firmware đồng bộ NTP (UTC+7) cho lịch hẹn; nếu chưa có NTP, timestamp dùng mốc tăng dần để ACK/dedup vẫn hoạt động.
* **Thiết kế gói tin và luồng phục hồi:** xem [docs/offline-sync.md](docs/offline-sync.md) (schema JSON, ACK, spool Gateway, giới hạn và sơ đồ Mermaid).

## 8. Phân công file (tránh xung đột Git)

| Thành viên | Phụ trách |
|---|---|
| SV1 | `firmware/src/sensor_filter.cpp`, `firmware/src/motor_control.cpp`, `firmware/include/sensor_filter.h`, `firmware/include/motor_control.h`, `firmware/diagram.json` |
| SV2 | `firmware/include/packet_schema.h`, `ring_buffer.*`, `ws_manager.*`, `firmware/src/main.cpp`, `backend-ws-gateway/server.js` |
| SV3 | `cloud-database/*.sql`, `dashboard-app/*`, `backend-ws-gateway/.env.example` |
