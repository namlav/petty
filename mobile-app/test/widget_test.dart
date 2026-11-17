import 'package:flutter_test/flutter_test.dart';

import 'package:petty_mobile/main.dart';
import 'package:petty_mobile/services/auth_service.dart';
import 'package:petty_mobile/state/app_state.dart';

void main() {
  testWidgets('Hiển thị màn đăng nhập khi chưa có session', (tester) async {
    final state = AppState();
    await tester.pumpWidget(PettyApp(appState: state));

    expect(find.text('Petty Smart Feeder'), findsOneWidget);
    expect(find.text('Đăng nhập'), findsOneWidget);
  });

  testWidgets('Điều hướng giữa các tab khi đã đăng nhập', (tester) async {
    final state = AppState()
      ..session = const AuthSession(
        accessToken: '',
        email: 'owner@petty.local',
        role: 'owner',
      );
    await tester.pumpWidget(PettyApp(appState: state));

    expect(find.text('Tổng quan'), findsWidgets);
    expect(find.text('Cho ăn ngay'), findsOneWidget);
    expect(find.text('Dung tích bát: 120 g'), findsOneWidget);

    await tester.tap(find.text('Lịch ăn'));
    await tester.pumpAndSettle();
    expect(find.text('Lịch cho ăn'), findsOneWidget);

    await tester.tap(find.text('Thống kê'));
    await tester.pumpAndSettle();
    expect(find.text('24 giờ'), findsOneWidget);

    await tester.tap(find.text('Cảnh báo'));
    await tester.pumpAndSettle();
    expect(find.text('Chưa có cảnh báo nào'), findsOneWidget);

    await tester.tap(find.text('Cài đặt'));
    await tester.pumpAndSettle();
    expect(find.text('Lưu bát'), findsOneWidget);
    expect(find.text('Đăng xuất'), findsOneWidget);
  });
}
