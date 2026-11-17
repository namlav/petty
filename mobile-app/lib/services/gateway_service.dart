import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/alert.dart';
import '../models/device.dart';
import '../models/schedule.dart';
import '../models/telemetry.dart';

/// [SV3: T-SV3-06] Giao tiếp WebSocket realtime & REST điều khiển với Gateway.
class GatewayService {
  String httpBaseUrl;
  String wsBaseUrl;
  String token;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _reconnectTimer;
  int _retrySeconds = 1;
  bool _disposed = false;

  final void Function(bool connected, String? error) onConnectionChanged;
  final void Function(List<DeviceInfo> devices) onDevices;
  final void Function(TelemetryPoint point) onTelemetry;
  final void Function(List<FeedingScheduleItem> schedules) onSchedules;
  final void Function(AlertItem alert) onAlert;
  final void Function(String deviceId, double bowlCapacityG)? onDeviceConfig;

  GatewayService({
    required this.httpBaseUrl,
    required this.wsBaseUrl,
    required this.token,
    required this.onConnectionChanged,
    required this.onDevices,
    required this.onTelemetry,
    required this.onSchedules,
    required this.onAlert,
    this.onDeviceConfig,
  });

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  void connect() {
    _disposed = false;
    _openSocket();
  }

  void _openSocket() {
    if (_disposed) return;
    _sub?.cancel();
    _channel?.sink.close();

    final sep = wsBaseUrl.contains('?') ? '&' : '?';
    final uri = Uri.parse(
      '$wsBaseUrl${sep}role=dashboard&token=${Uri.encodeQueryComponent(token)}',
    );
    try {
      _channel = WebSocketChannel.connect(uri);
      onConnectionChanged(true, null);
      _sub = _channel!.stream.listen(
        (raw) {
          _retrySeconds = 1;
          _handleMessage(raw.toString());
        },
        onError: (err) {
          onConnectionChanged(false, err.toString());
          _scheduleReconnect();
        },
        onDone: () {
          onConnectionChanged(false, 'Mất kết nối Gateway');
          _scheduleReconnect();
        },
      );
    } catch (e) {
      onConnectionChanged(false, e.toString());
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnectTimer?.cancel();
    final delay = Duration(seconds: _retrySeconds);
    _retrySeconds = (_retrySeconds * 2).clamp(1, 30);
    _reconnectTimer = Timer(delay, _openSocket);
  }

  void _handleMessage(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) return;

    switch (decoded['type']) {
      case 'snapshot':
        final data = decoded['data'] as Map<String, dynamic>? ?? {};
        final devices = (data['devices'] as List? ?? [])
            .map((e) => DeviceInfo.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList();
        onDevices(devices);
        for (final item in (data['recent'] as List? ?? [])) {
          onTelemetry(
            TelemetryPoint.fromJson(Map<String, dynamic>.from(item as Map)),
          );
        }
        if (data['schedules'] is List) {
          onSchedules(
            (data['schedules'] as List)
                .map((e) => FeedingScheduleItem.fromJson(
                    Map<String, dynamic>.from(e as Map)))
                .toList(),
          );
        }
        if (data['alerts'] is List) {
          for (final item in (data['alerts'] as List).reversed) {
            onAlert(AlertItem.fromJson(Map<String, dynamic>.from(item as Map)));
          }
        }
        break;
      case 'telemetry':
        if (decoded['data'] is Map) {
          onTelemetry(
            TelemetryPoint.fromJson(
                Map<String, dynamic>.from(decoded['data'] as Map)),
          );
        }
        break;
      case 'status':
        final devices = (decoded['devices'] as List? ?? [])
            .map((e) => DeviceInfo.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList();
        onDevices(devices);
        break;
      case 'alert':
        if (decoded['data'] is Map) {
          onAlert(
            AlertItem.fromJson(
                Map<String, dynamic>.from(decoded['data'] as Map)),
          );
        }
        break;
      case 'device_config':
        if (decoded['data'] is Map) {
          final data = Map<String, dynamic>.from(decoded['data'] as Map);
          final cap = (data['bowl_capacity_g'] as num?)?.toDouble();
          if (cap != null) {
            onDeviceConfig?.call((data['device_id'] ?? '').toString(), cap);
          }
        }
        break;
    }
  }

  Future<Map<String, dynamic>> feedNow(String deviceId, double grams) async {
    final resp = await http.post(
      Uri.parse('$httpBaseUrl/api/feed'),
      headers: _headers,
      body: jsonEncode({'device': deviceId, 'grams': grams}),
    );
    return _decodeOrThrow(resp);
  }

  Future<Map<String, dynamic>> stopFeeding(String deviceId) async {
    final resp = await http.post(
      Uri.parse('$httpBaseUrl/api/stop'),
      headers: _headers,
      body: jsonEncode({'device': deviceId}),
    );
    return _decodeOrThrow(resp);
  }

  Future<List<FeedingScheduleItem>> saveSchedules(
    String deviceId,
    List<FeedingScheduleItem> items,
  ) async {
    final resp = await http.put(
      Uri.parse('$httpBaseUrl/api/schedules'),
      headers: _headers,
      body: jsonEncode({
        'device': deviceId,
        'items': items.map((e) => e.toJson()).toList(),
      }),
    );
    final body = _decodeOrThrow(resp);
    return (body['items'] as List? ?? [])
        .map((e) =>
            FeedingScheduleItem.fromJson(Map<String, dynamic>.from(e as Map)))
        .toList();
  }

  Future<Map<String, dynamic>> updateDeviceConfig(
    String deviceId, {
    required double bowlCapacityG,
  }) async {
    final resp = await http.put(
      Uri.parse('$httpBaseUrl/api/devices/${Uri.encodeComponent(deviceId)}/config'),
      headers: _headers,
      body: jsonEncode({'bowl_capacity_g': bowlCapacityG}),
    );
    return _decodeOrThrow(resp);
  }

  void clearError(String deviceId) {
    _channel?.sink.add(jsonEncode({'cmd': 'CLEAR_ERROR', 'device': deviceId}));
  }

  Map<String, dynamic> _decodeOrThrow(http.Response resp) {
    final map = jsonDecode(resp.body) as Map<String, dynamic>;
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      if (map['error'] == 'bowl_full') {
        final w = (map['bowl_weight_g'] as num?)?.toStringAsFixed(1) ?? '?';
        final c = (map['bowl_capacity_g'] as num?)?.toStringAsFixed(0) ?? '?';
        throw Exception('Bát đã đầy ($w / $c g), không thể xả thêm');
      }
      throw Exception(map['error'] ?? 'HTTP ${resp.statusCode}');
    }
    return map;
  }

  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
  }
}
