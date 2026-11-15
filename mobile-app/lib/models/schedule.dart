/// Một khung giờ cho ăn tự động (tối đa 4 lịch/thiết bị theo TODO.md §2.4).
class FeedingScheduleItem {
  final int? id;
  final int hour;
  final int minute;
  final double grams;
  final bool enabled;

  const FeedingScheduleItem({
    this.id,
    required this.hour,
    required this.minute,
    required this.grams,
    required this.enabled,
  });

  factory FeedingScheduleItem.fromJson(Map<String, dynamic> json) {
    return FeedingScheduleItem(
      id: (json['id'] as num?)?.toInt(),
      hour: (json['hour'] as num?)?.toInt() ?? 8,
      minute: (json['minute'] as num?)?.toInt() ?? 0,
      grams: ((json['grams'] ?? json['target_grams']) as num?)?.toDouble() ?? 30,
      enabled: json['enabled'] == true,
    );
  }

  Map<String, dynamic> toJson() => {
        'hour': hour,
        'minute': minute,
        'grams': grams,
        'enabled': enabled,
      };

  FeedingScheduleItem copyWith({
    int? hour,
    int? minute,
    double? grams,
    bool? enabled,
  }) {
    return FeedingScheduleItem(
      id: id,
      hour: hour ?? this.hour,
      minute: minute ?? this.minute,
      grams: grams ?? this.grams,
      enabled: enabled ?? this.enabled,
    );
  }

  String get formattedTime =>
      '${hour.toString().padLeft(2, '0')}:${minute.toString().padLeft(2, '0')}';
}
