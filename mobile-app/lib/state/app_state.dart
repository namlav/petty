import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../config.dart';
import '../models/alert.dart';
import '../models/device.dart';
import '../models/schedule.dart';
import '../models/telemetry.dart';
import '../services/auth_service.dart';
import '../services/gateway_service.dart';
import '../services/history_service.dart';

/// State trung tâm của ứng dụng Flutter, kết nối Auth + Gateway + History.
class AppState extends ChangeNotifier {
  final AuthService _authService = AuthService();

  AuthSession? session;
  String gatewayHttpUrl = AppConfig.gatewayHttpUrl;
  String gatewayWsUrl = AppConfig.gatewayWsUrl;
  String selectedDeviceId = AppConfig.defaultDeviceId;

  bool gatewayConnected = false;
  String? gatewayStatusMessage;
  bool loading = false;
  String? lastError;

  List<DeviceInfo> devices = const [];
  final List<TelemetryPoint> liveTelemetry = [];
  List<FeedingScheduleItem> schedules = const [];
  List<ConsumptionBucket> stats = const [];
  String statsRange = '24h';
  final List<AlertItem> alerts = [];
  AlertItem? pendingLiveAlert;

  GatewayService? _gateway;
  HistoryService? _history;

  TelemetryPoint? get latest =>
      liveTelemetry.isNotEmpty ? liveTelemetry.last : null;

  bool get isDeviceOnline =>
      devices.any((d) => d.id == selectedDeviceId && d.online) ||
      (latest != null && latest!.status != 3);

  double get bowlCapacityG {
    for (final d in devices) {
      if (d.id == selectedDeviceId) return d.bowlCapacityG;
    }
    return 120;
  }

  static const _kHttpUrlKey = 'petty.gateway_http_url';
  static const _kWsUrlKey = 'petty.gateway_ws_url';

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    final savedHttp = prefs.getString(_kHttpUrlKey);
    final savedWs = prefs.getString(_kWsUrlKey);
    if (savedHttp != null && savedHttp.isNotEmpty) {
      gatewayHttpUrl = savedHttp;
    } else if (await _isReachable('http://127.0.0.1:8080/api/health')) {
      gatewayHttpUrl = 'http://127.0.0.1:8080';
      if (savedWs == null || savedWs.isEmpty) {
        gatewayWsUrl = 'ws://127.0.0.1:8080/ws';
      }
    }
    if (savedWs != null && savedWs.isNotEmpty) gatewayWsUrl = savedWs;

    session = await _authService.restoreSession();
    if (session != null) {
      _connectServices();
    }
    notifyListeners();
  }

  Future<bool> _isReachable(String url) async {
    try {
      final resp =
          await http.get(Uri.parse(url)).timeout(const Duration(seconds: 2));
      return resp.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  Future<void> signIn({
    required String email,
    required String password,
    String demoRole = 'owner',
    String manualToken = '',
  }) async {
    loading = true;
    lastError = null;
    notifyListeners();
    try {
      session = await _authService.signIn(
        email: email,
        password: password,
        demoRole: demoRole,
        manualToken: manualToken,
      );
      _connectServices();
      await refreshAll();
    } catch (e) {
      lastError = e.toString();
      rethrow;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> signOut() async {
    _gateway?.dispose();
    _gateway = null;
    _history = null;
    session = null;
    liveTelemetry.clear();
    alerts.clear();
    await _authService.signOut();
    notifyListeners();
  }

  Future<void> updateGatewayUrls({
    required String httpUrl,
    required String wsUrl,
  }) async {
    gatewayHttpUrl = httpUrl.trim();
    gatewayWsUrl = wsUrl.trim();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kHttpUrlKey, gatewayHttpUrl);
    await prefs.setString(_kWsUrlKey, gatewayWsUrl);
    if (session != null) {
      _connectServices();
    }
    notifyListeners();
  }

  void selectDevice(String deviceId) {
    selectedDeviceId = deviceId;
    refreshAll();
    notifyListeners();
  }

  void _connectServices() {
    _gateway?.dispose();
    final token = session?.accessToken ?? '';
    _history = HistoryService(httpBaseUrl: gatewayHttpUrl, token: token);
    _gateway = GatewayService(
      httpBaseUrl: gatewayHttpUrl,
      wsBaseUrl: gatewayWsUrl,
      token: token,
      onConnectionChanged: (connected, message) {
        gatewayConnected = connected;
        gatewayStatusMessage = message;
        notifyListeners();
      },
      onDevices: (list) {
        devices = list;
        notifyListeners();
      },
      onTelemetry: (point) {
        if (point.deviceId != selectedDeviceId) return;
        final exists = liveTelemetry.any((p) => p.seqNum == point.seqNum);
        if (exists) return;
        liveTelemetry.add(point);
        if (liveTelemetry.length > 60) {
          liveTelemetry.removeAt(0);
        }
        notifyListeners();
      },
      onSchedules: (list) {
        schedules = list;
        notifyListeners();
      },
      onAlert: (alert, {bool isLive = false}) {
        final isNew = !alerts.any((a) => a.id == alert.id);
        if (isNew) {
          alerts.insert(0, alert);
        }
        if (isLive && alert.deviceId == selectedDeviceId && alert.kind != 'ONLINE') {
          pendingLiveAlert = alert;
        }
        if (isNew || (isLive && pendingLiveAlert == alert)) {
          notifyListeners();
        }
      },
      onDeviceConfig: (deviceId, capacity) {
        _applyBowlCapacity(deviceId, capacity);
      },
    )..connect();
  }

  void _applyBowlCapacity(String deviceId, double capacity) {
    final idx = devices.indexWhere((d) => d.id == deviceId);
    if (idx >= 0) {
      devices[idx] = devices[idx].copyWith(bowlCapacityG: capacity);
    } else {
      devices.add(DeviceInfo(
        id: deviceId,
        name: 'Pet Feeder - $deviceId',
        online: isDeviceOnline,
        bowlCapacityG: capacity,
      ));
    }
    notifyListeners();
  }

  Future<void> refreshAll() async {
    final hist = _history;
    if (hist == null) return;
    try {
      final results = await Future.wait([
        hist.fetchDevices(),
        hist.fetchSchedules(selectedDeviceId),
        hist.fetchStats(selectedDeviceId, range: statsRange),
        hist.fetchAlerts(selectedDeviceId),
      ]);
      devices = results[0] as List<DeviceInfo>;
      schedules = results[1] as List<FeedingScheduleItem>;
      stats = results[2] as List<ConsumptionBucket>;
      final fetchedAlerts = results[3] as List<AlertItem>;
      alerts
        ..clear()
        ..addAll(fetchedAlerts);
      lastError = null;
    } catch (e) {
      lastError = 'Không tải được dữ liệu Gateway: $e';
    }
    notifyListeners();
  }

  Future<void> loadStats(String range) async {
    statsRange = range;
    final hist = _history;
    if (hist == null) return;
    try {
      stats = await hist.fetchStats(selectedDeviceId, range: range);
      lastError = null;
    } catch (e) {
      lastError = e.toString();
    }
    notifyListeners();
  }

  Future<String> feedNow(double grams) async {
    final gw = _gateway;
    if (gw == null) return 'Chưa kết nối Gateway';
    final res = await gw.feedNow(selectedDeviceId, grams);
    if (res['ok'] != true) {
      return 'Thiết bị đang offline, chưa nhận lệnh';
    }
    final actual = (res['grams'] as num?)?.toDouble() ?? grams;
    if (res['clamped'] == true) {
      final cap = (res['bowl_capacity_g'] as num?)?.toDouble() ?? bowlCapacityG;
      return 'Bát sắp đầy: tự cắt còn ${actual.toStringAsFixed(0)} g (vừa đầy ${cap.toStringAsFixed(0)} g)';
    }
    return 'Đã gửi lệnh cho ăn ${actual.toStringAsFixed(0)} g';
  }

  Future<double> updateBowlCapacity(double grams) async {
    final gw = _gateway;
    if (gw == null) throw Exception('Chưa kết nối Gateway');
    final res = await gw.updateDeviceConfig(selectedDeviceId, bowlCapacityG: grams);
    final updated = (res['bowl_capacity_g'] as num?)?.toDouble() ?? grams;
    _applyBowlCapacity(selectedDeviceId, updated);
    return updated;
  }

  Future<String> stopFeeding() async {
    final gw = _gateway;
    if (gw == null) return 'Chưa kết nối Gateway';
    final res = await gw.stopFeeding(selectedDeviceId);
    return res['ok'] == true
        ? 'Đã gửi lệnh dừng khẩn cấp'
        : 'Thiết bị đang offline';
  }

  Future<void> saveSchedules(List<FeedingScheduleItem> items) async {
    final gw = _gateway;
    if (gw == null) return;
    schedules = await gw.saveSchedules(selectedDeviceId, items);
    notifyListeners();
  }

  void clearPendingLiveAlert() {
    if (pendingLiveAlert != null) {
      pendingLiveAlert = null;
    }
  }

  void clearError() {
    _gateway?.clearError(selectedDeviceId);
  }

  void markAlertRead(String id) {
    final idx = alerts.indexWhere((a) => a.id == id);
    if (idx >= 0) {
      alerts[idx] = alerts[idx].markRead();
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _gateway?.dispose();
    super.dispose();
  }
}
