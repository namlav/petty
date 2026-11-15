# Mô hình CSDL NoSQL / Time-series trên Firebase Cloud Firestore (`petty`)

> **[SV3: T-SV3-01]** Thiết kế cho gói **Firebase Spark (Miễn phí - $0/tháng)**, không sử dụng Cloud Functions (tránh yêu cầu gói Blaze). Mọi logic đồng bộ, đếm bucket thống kê và quét thiết bị offline chạy trên `backend-ws-gateway` thông qua **Firebase Admin SDK**.

---

## 1. Cấu trúc Collections & Documents

### 1.1 `users/{uid}`
Lưu hồ sơ và vai trò RBAC tương ứng Firebase Authentication UID.
* `email`: `string`
* `role`: `'admin' | 'owner' | 'viewer'` (mặc định `'viewer'` khi tự đăng ký)
* `created_at`: `timestamp / ISO-8601 string`

### 1.2 `devices/{deviceId}` (vd: `esp01`)
Trạng thái thời gian thực và quyền sở hữu từng thiết bị.
* `id`: `string` (`esp01`)
* `owner_id`: `string` (Firebase Auth UID của Owner)
* `member_ids`: `string[]` (danh sách UID của các Member được phép xem)
* `name`: `string` (`Pet Feeder - esp01`)
* `online`: `boolean` (cập nhật khi thiết bị WS connect/close và quét stale 60s trên Gateway)
* `last_seen`: `timestamp / ISO-8601 string`
* `portion_grams`: `number` (mặc định `30.0`)
* `bowl_weight_g`: `number`
* `food_level`: `number` (`0..100`)

### 1.3 `feeding_schedules/{scheduleId}`
Lưu tối đa 4 lịch/thiết bị (bản gốc trên Cloud, được đồng bộ xuống NVS của ESP32 qua `SET_SCHEDULES`).
* `device_id`: `string`
* `hour`: `number` (`0..23`)
* `minute`: `number` (`0..59`)
* `grams`: `number` (`1..200`)
* `enabled`: `boolean`
* `updated_at`: `string`

### 1.4 `telemetry_logs/{deviceId}_{seqNum}` (Time-series)
* **Document ID tất định:** `${device_id}_${seq_num}` (ví dụ `esp01_104`). Khi ESP32 đồng bộ lại từ Ring Buffer sau mất mạng hoặc Gateway phát lại spool, thao tác `.set()` vào cùng ID là **idempotent** — tuyệt đối không tạo bản ghi trùng!
* **Fields:**
  * `device_id`: `string`
  * `seq_num`: `number`
  * `recorded_at`: `string` (ISO-8601 UTC, có Composite Index `(device_id ASC, recorded_at DESC)` để truy vấn biểu đồ realtime cực nhanh)
  * `weight_g`: `number`
  * `food_level`: `number`
  * `status`: `number` (`0` Idle, `1` Feeding, `2` Offline-Synced, `3` Error)
  * `error_code`: `number` (`0` OK, `1` Jam, `2` Empty, `3` Sensor)
  * `synced`: `boolean`
  * `raw`: `map` (payload gốc)

### 1.5 `device_commands/{cid}`
Hàng đợi lệnh từ App/Dashboard xuống ESP32 (`FEED`, `STOP`, `SET_SCHEDULES`, `CLEAR_ERROR`).
* `cid`: `number`
* `device_id`: `string`
* `command`: `string`
* `payload`: `map`
* `acked`: `boolean` (`true` sau khi ESP32 gửi `{"cack": cid, "ok": true}`)
* `attempts`: `number`
* `created_at`: `string`
* `delivered_at`: `string | null`

### 1.6 `alerts/{alertId}`
Lịch sử cảnh báo từ Alert Engine và nguồn hiển thị màn hình Alerts.
* `device_id`: `string`
* `kind`: `'LOW_FOOD' | 'EMPTY' | 'JAM' | 'SENSOR' | 'OFFLINE' | 'ONLINE'`
* `message`: `string`
* `created_at`: `string`
* `pushed`: `boolean`
* `read_at`: `string | null`

### 1.7 `feeding_events/{eventId}`
Ghi nhận mỗi chu trình xả hạt hoàn tất (suy ra từ chuyển trạng thái `st: 1 -> 0/3`).
* `device_id`: `string`
* `started_at`: `string`
* `finished_at`: `string`
* `source`: `'manual' | 'schedule' | 'button'`
* `target_g`: `number | null`
* `dispensed_g`: `number`
* `result`: `number` (`0` OK, `1` JAM, `2` STOPPED, `3` EMPTY)

### 1.8 `stats_hourly/{deviceId}_{YYYYMMDDHH}` & `stats_daily/{deviceId}_{YYYYMMDD}`
Tổng hợp sẵn lượng thức ăn thú cưng đã ăn (cập nhật tăng dần `FieldValue.increment(eatenDelta)` ngay khi nhận telemetry giảm cân ngoài lúc đang xả hạt) giúp App Flutter vẽ biểu đồ `fl_chart` 24h / 7 ngày / 30 ngày chỉ bằng 1 lần query, tiết kiệm quota đọc gói Spark (50.000 reads/ngày).
* `device_id`: `string`
* `bucket`: `string` (ISO-8601 đầu giờ hoặc đầu ngày UTC+7)
* `eaten_g`: `number`

### 1.9 `fcm_tokens/{token}` & `device_credentials/{deviceId}`
* `fcm_tokens`: `{ token, user_id, platform ('android'|'ios'|'web'), updated_at }`
* `device_credentials`: `{ device_id, token_hash (SHA-256), updated_at }` — chỉ Admin SDK / admin đọc ghi.

---

## 2. Triển khai lên Firebase Console (Spark)
1. Vào **Firebase Console** (`petty-68437`) → **Build → Firestore Database → Create database** (chọn chế độ Production, khu vực gần nhất như `asia-southeast1`).
2. Vào tab **Rules** → dán nội dung `cloud-database/firestore.rules` → **Publish**.
3. Vào tab **Indexes** (hoặc dùng `firebase deploy --only firestore:indexes`) để tạo các Composite Index trong `cloud-database/firestore.indexes.json`.
4. Vào **Authentication → Sign-in method** → bật **Email/Password**.
