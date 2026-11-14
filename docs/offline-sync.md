# Giao thức telemetry và đồng bộ ngoại tuyến

## Gói tin nhỏ gọn

Gateway và firmware dùng JSON UTF-8 qua WebSocket để không cần thư viện giải mã Protobuf trên ESP32. Tên trường ngắn giữ payload telemetry thường ở khoảng 80–100 byte (tùy giá trị số và `DEVICE_ID`). Mỗi gói là một sự kiện bất biến; không dùng timestamp làm khóa duy nhất.

```json
{"v":1,"id":"esp01","s":104,"t":1763040000,"w":85.4,"l":72,"st":1,"e":0,"q":3}
```

| Trường | Ý nghĩa | Kiểu / đơn vị |
|---|---|---|
| `v` | Phiên bản schema | uint8 |
| `id` | ID thiết bị | chuỗi ngắn |
| `s` | Số thứ tự tăng đơn điệu theo thiết bị | uint32 |
| `t` | Thời điểm đo Unix | giây UTC |
| `w` | Khối lượng | gram, 0.1 g |
| `l` | Mức thức ăn | phần trăm 0–100 |
| `st` | Trạng thái: 0 idle, 1 feeding, 2 offline-synced, 3 error | uint8 |
| `e` | Mã lỗi: 0 none, 1 jam, 2 empty, 3 sensor | uint8 |
| `q` | Số gói còn chờ trên thiết bị; chỉ gửi khi khác 0 | uint16, tùy chọn |

ACK chỉ gồm `{"ack":104}`. Lệnh dùng `cmd` và các khóa ngắn như `g`, `h`, `m`, `on`. Giữ `v` để nâng schema có kiểm soát. Nếu nhiều thiết bị chạy qua mạng di động hoặc cần giảm payload thêm, có thể chuyển frame sang Protobuf; các trường tương ứng nên giữ đúng số thứ tự, đơn vị và quy tắc idempotency trên.

## Lưu đệm tại Edge Gateway

Node Gateway ghi mỗi telemetry thành một dòng JSON trong `backend-ws-gateway/telemetry-spool.jsonl`, gọi `fsync`, rồi mới trả ACK. Khi Gateway khởi động lại, nó nạp lại các dòng còn chờ. Khi Supabase hoạt động, Gateway đẩy FIFO từng bản ghi và compact spool sau mỗi lần thành công. Nếu dừng giữa lúc ghi cloud và compact, cùng bản ghi được gửi lại; unique key `(device_id, seq_num)` khiến thao tác lặp an toàn.

ESP32 vẫn giữ ring buffer hai tầng: RAM 64 bản ghi để đợi ACK và LittleFS 500 bản ghi để đệm mất mạng. Khi WebSocket rớt, các bản ghi chưa ACK chuyển từ RAM xuống flash; khi kết nối lại, thiết bị gửi FIFO từng bản ghi và chỉ bỏ bản ghi sau ACK. Queue đầy thì từ chối gói mới và báo lỗi thay vì âm thầm ghi đè bản ghi chưa đồng bộ. LittleFS không tự format nếu mount lỗi.

Gateway ACK xác nhận dữ liệu đã được ghi bền ở Gateway; ACK không có nghĩa dữ liệu đã đến Supabase. `GET /api/health` trả `buffered_records` là số bản ghi chưa ghi cloud. Nếu không cấu hình Supabase, spool giữ dữ liệu tại Gateway cho tới khi cấu hình/khôi phục đích lưu trữ.

## Luồng xử lý sự cố và auto-sync

```mermaid
sequenceDiagram
    participant D as ESP32 / Edge
    participant G as WebSocket Gateway
    participant S as Supabase
    participant UI as Dashboard
    D->>G: telemetry (id, seq, ts, values)
    G->>G: append JSONL + fsync
    alt ghi spool thành công
        G-->>D: ACK(seq)
        G->>UI: telemetry realtime
        G->>S: POST telemetry (FIFO, retry)
        S-->>G: thành công / unique key
        G->>G: bỏ head + compact spool
    else lỗi lưu spool
        G-->>D: không ACK
        D->>D: giữ gói trong ring buffer
    end
    Note over D,G: Khi Wi-Fi/WebSocket mất, ESP32 tiếp tục đo và lưu flash
    D->>G: reconnect + gửi lại gói cũ nhất
    G->>G: deduplicate (device_id, seq)
    G-->>D: ACK sau khi đã spool bền
    G->>S: đồng bộ FIFO; retry nếu cloud chưa sẵn sàng
    G-->>UI: cập nhật trạng thái SYNCING / số pending
```

Khuyến nghị triển khai thật: đặt `TELEMETRY_SPOOL_PATH` trên phân vùng đĩa bền có đủ dung lượng và giám sát dung lượng trống. Spool JSONL hiện chưa áp dụng giới hạn dung lượng hay chính sách lưu trữ; không xóa file spool thủ công khi còn pending.

### Biến thể Protobuf

Nếu đường truyền bị giới hạn băng thông, frame binary có thể dùng schema tương đương sau. `weight_dg` là số nguyên decigram để tránh float; `device_id` vẫn giữ trong mỗi gói để phục vụ định tuyến và dedup.

```protobuf
syntax = "proto3";
message Telemetry {
  uint32 schema_version = 1;
  string device_id = 2;
  uint32 seq = 3;
  uint32 event_time_s = 4;
  sint32 weight_dg = 5;
  uint32 food_level_pct = 6;
  uint32 status = 7;
  uint32 error_code = 8;
  uint32 pending_count = 9;
}
message Ack { uint32 seq = 1; }
```

Trong Protobuf, các field number là một phần của hợp đồng lâu dài: không tái sử dụng số field đã bỏ, và thêm trường mới bằng số chưa dùng.
