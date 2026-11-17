import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/alert.dart';
import '../models/device.dart';
import '../models/schedule.dart';
import '../models/telemetry.dart';

class ConsumptionBucket {
  final DateTime bucket;
  final double eatenG;

  const ConsumptionBucket({required this.bucket, required this.eatenG});

  factory ConsumptionBucket.fromJson(Map<String, dynamic> json) {
    return ConsumptionBucket(
      bucket: DateTime.tryParse(json['bucket']?.toString() ?? '') ??
          DateTime.now(),
      eatenG: (json['eaten_g'] as num?)?.toDouble() ?? 0,
    );
  }
}

/// [SV3: T-SV3-05 / T-SV3-06] Đọc lịch sử telemetry, thống kê, lịch ăn và cảnh báo.
class HistoryService {
  static const Duration _timeout = Duration(seconds: 8);
  final String httpBaseUrl;
  String token;

  HistoryService({required this.httpBaseUrl, required this.token});

  Map<String, String> get _headers => {
        if (token.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  Future<List<DeviceInfo>> fetchDevices() async {
    final resp = await http
        .get(Uri.parse('$httpBaseUrl/api/devices'), headers: _headers)
        .timeout(_timeout);
    if (resp.statusCode != 200) throw Exception('HTTP ${resp.statusCode}');
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    return (body['data'] as List? ?? [])
        .map((e) => DeviceInfo.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<List<TelemetryPoint>> fetchTelemetry(
    String deviceId, {
    int limit = 100,
  }) async {
    final uri = Uri.parse(
      '$httpBaseUrl/api/telemetry?device=$deviceId&limit=$limit',
    );
    final resp = await http.get(uri, headers: _headers).timeout(_timeout);
    if (resp.statusCode != 200) throw Exception('HTTP ${resp.statusCode}');
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    return (body['data'] as List? ?? [])
        .map((e) => TelemetryPoint.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<List<ConsumptionBucket>> fetchStats(
    String deviceId, {
    String range = '24h',
  }) async {
    final uri = Uri.parse(
      '$httpBaseUrl/api/stats?device=$deviceId&range=$range',
    );
    final resp = await http.get(uri, headers: _headers).timeout(_timeout);
    if (resp.statusCode != 200) throw Exception('HTTP ${resp.statusCode}');
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    return (body['data'] as List? ?? [])
        .map((e) =>
            ConsumptionBucket.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<List<FeedingScheduleItem>> fetchSchedules(String deviceId) async {
    final uri = Uri.parse('$httpBaseUrl/api/schedules?device=$deviceId');
    final resp = await http.get(uri, headers: _headers).timeout(_timeout);
    if (resp.statusCode != 200) throw Exception('HTTP ${resp.statusCode}');
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    return (body['data'] as List? ?? [])
        .map((e) =>
            FeedingScheduleItem.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<List<AlertItem>> fetchAlerts(String deviceId) async {
    final uri = Uri.parse('$httpBaseUrl/api/alerts?device=$deviceId');
    final resp = await http.get(uri, headers: _headers).timeout(_timeout);
    if (resp.statusCode != 200) throw Exception('HTTP ${resp.statusCode}');
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    return (body['data'] as List? ?? [])
        .map((e) => AlertItem.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }
}
