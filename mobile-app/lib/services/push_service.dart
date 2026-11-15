import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// [SV3: T-SV3-04 / T-SV3-06] Đăng ký FCM token và xử lý thông báo đẩy.
/// TODO(T-SV3-04): Khi đã thêm google-services.json và bật firebase_messaging trong pubspec.yaml,
/// gọi FirebaseMessaging.instance.getToken() và lắng nghe onMessage / onMessageOpenedApp.
class PushService {
  final String httpBaseUrl;
  String token;

  PushService({required this.httpBaseUrl, required this.token});

  Future<void> registerDeviceToken({
    required String fcmToken,
    String platform = 'android',
  }) async {
    if (fcmToken.isEmpty) return;
    try {
      await http.post(
        Uri.parse('$httpBaseUrl/api/fcm-token'),
        headers: {
          'Content-Type': 'application/json',
          if (token.isNotEmpty) 'Authorization': 'Bearer $token',
        },
        body: jsonEncode({'token': fcmToken, 'platform': platform}),
      );
    } catch (e) {
      debugPrint('[PushService] Không gửi được FCM token: $e');
    }
  }
}
