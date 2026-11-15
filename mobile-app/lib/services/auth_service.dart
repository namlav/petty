import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../config.dart';

/// Phiên đăng nhập của người dùng (Firebase ID Token / JWT + role RBAC).
class AuthSession {
  final String accessToken;
  final String email;
  final String role; // admin | owner | viewer

  const AuthSession({
    required this.accessToken,
    required this.email,
    required this.role,
  });

  bool get canControl => role == 'admin' || role == 'owner';
}

/// [SV3: T-SV3-03 / T-SV3-06] Xác thực Firebase Auth (hoặc chế độ demo cục bộ).
class AuthService {
  static const _kTokenKey = 'petty.access_token';
  static const _kEmailKey = 'petty.user_email';
  static const _kRoleKey = 'petty.user_role';

  Future<AuthSession?> restoreSession() async {
    final prefs = await SharedPreferences.getInstance();
    final email = prefs.getString(_kEmailKey);
    if (email == null || email.isEmpty) return null;
    return AuthSession(
      accessToken: prefs.getString(_kTokenKey) ?? '',
      email: email,
      role: prefs.getString(_kRoleKey) ?? 'owner',
    );
  }

  /// Đăng nhập Email/Password qua Firebase Auth REST API hoặc chế độ demo Gateway.
  /// TODO(T-SV3-03/T-SV3-06): Thay bằng `FirebaseAuth.instance.signInWithEmailAndPassword`
  /// và đồng bộ ID token khi bật firebase_auth trong pubspec.yaml.
  Future<AuthSession> signIn({
    required String email,
    required String password,
    String demoRole = 'owner',
    String manualToken = '',
  }) async {
    AuthSession session;

    if (AppConfig.firebaseWebApiKey.isNotEmpty && manualToken.isEmpty) {
      final uri = Uri.parse(
        'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword'
        '?key=${AppConfig.firebaseWebApiKey}',
      );
      final resp = await http.post(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'email': email,
          'password': password,
          'returnSecureToken': true,
        }),
      );
      if (resp.statusCode != 200) {
        final err = jsonDecode(resp.body);
        throw Exception(err['error']?['message'] ?? 'Đăng nhập Firebase thất bại');
      }
      final data = jsonDecode(resp.body) as Map<String, dynamic>;
      session = AuthSession(
        accessToken: (data['idToken'] ?? '').toString(),
        email: (data['email'] ?? email).toString(),
        role: demoRole,
      );
    } else {
      // Chế độ demo Gateway (JWT_SECRET trống => Gateway tự gán admin; hoặc dán token tay).
      session = AuthSession(
        accessToken: manualToken.trim(),
        email: email.isEmpty ? 'demo@petty.local' : email,
        role: demoRole,
      );
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kTokenKey, session.accessToken);
    await prefs.setString(_kEmailKey, session.email);
    await prefs.setString(_kRoleKey, session.role);
    return session;
  }

  Future<void> signOut() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kTokenKey);
    await prefs.remove(_kEmailKey);
    await prefs.remove(_kRoleKey);
  }
}
