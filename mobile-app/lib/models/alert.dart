/// Sự kiện cảnh báo từ Gateway / bảng public.alerts.
class AlertItem {
  final String id;
  final String deviceId;
  final String kind; // LOW_FOOD | EMPTY | JAM | SENSOR | OFFLINE | ONLINE
  final String message;
  final DateTime createdAt;
  final bool read;

  const AlertItem({
    required this.id,
    required this.deviceId,
    required this.kind,
    required this.message,
    required this.createdAt,
    this.read = false,
  });

  factory AlertItem.fromJson(Map<String, dynamic> json) {
    return AlertItem(
      id: (json['id'] ?? '').toString(),
      deviceId: (json['device_id'] ?? 'esp01').toString(),
      kind: (json['kind'] ?? 'INFO').toString(),
      message: (json['message'] ?? '').toString(),
      createdAt: DateTime.tryParse(json['created_at']?.toString() ?? '') ??
          DateTime.now(),
      read: json['read_at'] != null,
    );
  }

  AlertItem markRead() => AlertItem(
        id: id,
        deviceId: deviceId,
        kind: kind,
        message: message,
        createdAt: createdAt,
        read: true,
      );
}
