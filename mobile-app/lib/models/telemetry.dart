/// Bản ghi telemetry đồng bộ từ Gateway (/api/telemetry & WebSocket).
class TelemetryPoint {
  final String deviceId;
  final int seqNum;
  final DateTime recordedAt;
  final double weightG;
  final int foodLevel;
  final int status; // 0 Idle, 1 Feeding, 2 Offline-Synced, 3 Error
  final int errorCode; // 0 OK, 1 Jam, 2 Empty, 3 Sensor
  final int buffered;
  final bool synced;

  const TelemetryPoint({
    required this.deviceId,
    required this.seqNum,
    required this.recordedAt,
    required this.weightG,
    required this.foodLevel,
    required this.status,
    required this.errorCode,
    this.buffered = 0,
    this.synced = false,
  });

  factory TelemetryPoint.fromJson(Map<String, dynamic> json) {
    return TelemetryPoint(
      deviceId: (json['device_id'] ?? 'esp01').toString(),
      seqNum: (json['seq_num'] as num?)?.toInt() ?? 0,
      recordedAt: DateTime.tryParse(json['recorded_at']?.toString() ?? '') ??
          DateTime.now(),
      weightG: (json['weight_g'] as num?)?.toDouble() ?? 0,
      foodLevel: (json['food_level'] as num?)?.toInt() ?? 0,
      status: (json['status'] as num?)?.toInt() ?? 0,
      errorCode: (json['error_code'] as num?)?.toInt() ?? 0,
      buffered: (json['buffered'] as num?)?.toInt() ?? 0,
      synced: json['synced'] == true,
    );
  }

  String get statusLabel {
    switch (status) {
      case 1:
        return 'FEEDING';
      case 2:
        return 'SYNCING';
      case 3:
        return 'ERROR';
      default:
        return 'ONLINE';
    }
  }

  String get errorLabel {
    switch (errorCode) {
      case 1:
        return 'Kẹt hạt (JAM)';
      case 2:
        return 'Thùng cạn (EMPTY)';
      case 3:
        return 'Lỗi cảm biến (SENSOR)';
      default:
        return 'Bình thường';
    }
  }
}
