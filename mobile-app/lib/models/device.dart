/// Thông tin thiết bị từ bảng public.devices / GET /api/devices.
class DeviceInfo {
  final String id;
  final String name;
  final bool online;
  final DateTime? lastSeen;
  final double portionGrams;
  final double bowlWeightG;
  final int foodLevel;

  const DeviceInfo({
    required this.id,
    required this.name,
    required this.online,
    this.lastSeen,
    this.portionGrams = 30,
    this.bowlWeightG = 0,
    this.foodLevel = 0,
  });

  factory DeviceInfo.fromJson(Map<String, dynamic> json) {
    return DeviceInfo(
      id: (json['id'] ?? 'esp01').toString(),
      name: (json['name'] ?? 'Pet Feeder').toString(),
      online: json['online'] == true,
      lastSeen: json['last_seen'] != null
          ? DateTime.tryParse(json['last_seen'].toString())
          : null,
      portionGrams: (json['portion_grams'] as num?)?.toDouble() ?? 30,
      bowlWeightG: (json['bowl_weight_g'] as num?)?.toDouble() ?? 0,
      foodLevel: (json['food_level'] as num?)?.toInt() ?? 0,
    );
  }
}
