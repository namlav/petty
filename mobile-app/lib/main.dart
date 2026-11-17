import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/alerts_screen.dart';
import 'screens/dashboard_screen.dart';
import 'screens/login_screen.dart';
import 'screens/schedules_screen.dart';
import 'screens/settings_screen.dart';
import 'screens/statistics_screen.dart';
import 'state/app_state.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(PettyApp(appState: AppState()..init()));
}

class PettyApp extends StatelessWidget {
  final AppState appState;

  const PettyApp({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider.value(
      value: appState,
      child: MaterialApp(
        title: 'Petty Smart Feeder',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorSchemeSeed: Colors.teal,
          useMaterial3: true,
        ),
        home: const _RootGate(),
      ),
    );
  }
}

class _RootGate extends StatelessWidget {
  const _RootGate();

  @override
  Widget build(BuildContext context) {
    final session = context.watch<AppState>().session;
    if (session == null) {
      return const LoginScreen();
    }
    return const HomeShell();
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tabIndex = 0;
  String? _lastShownAlertId;

  static const _titles = [
    'Tổng quan',
    'Lịch cho ăn',
    'Thống kê',
    'Cảnh báo',
    'Cài đặt',
  ];

  static const _screens = [
    DashboardScreen(),
    SchedulesScreen(),
    StatisticsScreen(),
    AlertsScreen(),
    SettingsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final unread = state.alerts.where((a) => !a.read).length;
    final liveAlert = state.pendingLiveAlert;
    if (liveAlert != null && liveAlert.id != _lastShownAlertId) {
      _lastShownAlertId = liveAlert.id;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        state.clearPendingLiveAlert();
        if (!mounted) return;
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(
            SnackBar(
              backgroundColor: Colors.red.shade700,
              content: Text('⚠️ ${liveAlert.message}'),
              duration: const Duration(seconds: 5),
            ),
          );
      });
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(_titles[_tabIndex]),
      ),
      body: _screens[_tabIndex],
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (idx) => setState(() => _tabIndex = idx),
        destinations: [
          const NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: 'Tổng quan',
          ),
          const NavigationDestination(
            icon: Icon(Icons.schedule_outlined),
            selectedIcon: Icon(Icons.schedule),
            label: 'Lịch ăn',
          ),
          const NavigationDestination(
            icon: Icon(Icons.bar_chart_outlined),
            selectedIcon: Icon(Icons.bar_chart),
            label: 'Thống kê',
          ),
          NavigationDestination(
            icon: Badge(
              isLabelVisible: unread > 0,
              label: Text('$unread'),
              child: const Icon(Icons.notifications_outlined),
            ),
            selectedIcon: const Icon(Icons.notifications),
            label: 'Cảnh báo',
          ),
          const NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Cài đặt',
          ),
        ],
      ),
    );
  }
}
