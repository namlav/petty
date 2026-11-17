import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';

/// [SV3: T-SV3-06] Lịch sử cảnh báo (FCM & realtime alert engine).
class AlertsScreen extends StatelessWidget {
  const AlertsScreen({super.key});

  IconData _iconForKind(String kind) {
    switch (kind) {
      case 'JAM':
        return Icons.warning_amber;
      case 'EMPTY':
      case 'LOW_FOOD':
        return Icons.inventory_2_outlined;
      case 'OFFLINE':
        return Icons.wifi_off;
      case 'ONLINE':
        return Icons.wifi;
      default:
        return Icons.notifications_active_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final items = state.alerts;

    return RefreshIndicator(
      onRefresh: state.refreshAll,
      child: items.isEmpty
          ? ListView(
              children: const [
                SizedBox(height: 120),
                Center(child: Text('Chưa có cảnh báo nào')),
              ],
            )
          : ListView.builder(
              padding: const EdgeInsets.all(12),
              itemCount: items.length,
              itemBuilder: (ctx, i) {
                final alert = items[i];
                final time = DateFormat('dd/MM HH:mm:ss')
                    .format(alert.createdAt.toLocal());
                return Card(
                  child: ListTile(
                    leading: Icon(
                      _iconForKind(alert.kind),
                      color: alert.kind == 'ONLINE' ? Colors.green : Colors.orange,
                    ),
                    title: Text(alert.message),
                    subtitle: Text('${alert.kind} · $time'),
                    trailing: alert.read
                        ? const Icon(Icons.done_all, size: 18)
                        : TextButton(
                            onPressed: () => state.markAlertRead(alert.id),
                            child: const Text('Đã đọc'),
                          ),
                  ),
                );
              },
            ),
    );
  }
}
