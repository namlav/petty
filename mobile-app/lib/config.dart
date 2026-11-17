/// [SV3: T-SV3-06] Cấu hình kết nối toàn cục của Flutter App (100% Firebase).
/// Ghi đè khi build/chạy bằng --dart-define=GATEWAY_HTTP_URL=https://...
class AppConfig {
  static const String firebaseProjectId = String.fromEnvironment(
    'FIREBASE_PROJECT_ID',
    defaultValue: 'petty-68437',
  );
  static const String firebaseWebApiKey = String.fromEnvironment(
    'FIREBASE_WEB_API_KEY',
    defaultValue: '',
  );
  static const String gatewayHttpUrl = String.fromEnvironment(
    'GATEWAY_HTTP_URL',
    // Android emulator dùng 10.0.2.2 để trỏ về localhost máy host
    defaultValue: 'http://10.0.2.2:8080',
  );
  static const String gatewayWsUrl = String.fromEnvironment(
    'GATEWAY_WS_URL',
    defaultValue: 'ws://10.0.2.2:8080/ws',
  );
  static const String defaultDeviceId = String.fromEnvironment(
    'DEFAULT_DEVICE_ID',
    defaultValue: 'esp01',
  );
}
