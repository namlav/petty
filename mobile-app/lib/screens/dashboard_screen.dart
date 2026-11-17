import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';

/// [SV3: T-SV3-06] Màn hình chính: khối lượng bát, mức hạt, trạng thái SYNC & nút Cho ăn.
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  double _feedGrams = 30;
  bool _busy = false;

  Future<void> _sendFeed(AppState state) async {
    setState(() => _busy = true);
    try {
      final msg = await state.feedNow(_feedGrams);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Lỗi: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendStop(AppState state) async {
    setState(() => _busy = true);
    try {
      final msg = await state.stopFeeding();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Lỗi: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final latest = state.latest;
    final canControl = state.session?.canControl ?? false;

    final statusText = !state.gatewayConnected
        ? 'OFFLINE GATEWAY'
        : latest == null
            ? (state.isDeviceOnline ? 'ONLINE' : 'OFFLINE')
            : latest.statusLabel;

    final levelPct = latest?.foodLevel ?? 0;
    final weightG = latest?.weightG ?? 0;

    return RefreshIndicator(
      onRefresh: state.refreshAll,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: Icon(
                state.gatewayConnected ? Icons.cloud_done : Icons.cloud_off,
                color: state.gatewayConnected ? Colors.green : Colors.orange,
              ),
              title: Text('Thiết bị: ${state.selectedDeviceId} · $statusText'),
              subtitle: Text(
                'Ring Buffer chờ đồng bộ (q): ${latest?.buffered ?? 0} gói'
                '${latest != null && latest.errorCode > 0 ? ' · ${latest.errorLabel}' : ''}',
              ),
              trailing: latest != null && latest.errorCode > 0 && canControl
                  ? TextButton(
                      onPressed: state.clearError,
                      child: const Text('Xoá lỗi'),
                    )
                  : null,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _MetricCard(
                  icon: Icons.scale,
                  label: 'Khối lượng khay',
                  value: '${weightG.toStringAsFixed(1)} g',
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _MetricCard(
                  icon: Icons.inventory_2_outlined,
                  label: 'Mức hạt phễu',
                  value: '$levelPct %',
                  progress: levelPct / 100.0,
                  lowWarning: levelPct < 15,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Điều khiển cho ăn từ xa',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      const Text('Khẩu phần:'),
                      Expanded(
                        child: Slider(
                          value: _feedGrams,
                          min: 10,
                          max: 200,
                          divisions: 19,
                          label: '${_feedGrams.toInt()} g',
                          onChanged: canControl
                              ? (v) => setState(() => _feedGrams = v)
                              : null,
                        ),
                      ),
                      Text('${_feedGrams.toInt()} g'),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: FilledButton.icon(
                          onPressed: canControl && !_busy
                              ? () => _sendFeed(state)
                              : null,
                          icon: const Icon(Icons.restaurant),
                          label: const Text('Cho ăn ngay'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: canControl && !_busy
                              ? () => _sendStop(state)
                              : null,
                          icon: const Icon(Icons.stop_circle_outlined),
                          label: const Text('Dừng khẩn cấp'),
                        ),
                      ),
                    ],
                  ),
                  if (!canControl)
                    const Padding(
                      padding: EdgeInsets.only(top: 8),
                      child: Text(
                        'Tài khoản Viewer chỉ có quyền xem (RBAC).',
                        style: TextStyle(fontSize: 12, color: Colors.grey),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final double? progress;
  final bool lowWarning;

  const _MetricCard({
    required this.icon,
    required this.label,
    required this.value,
    this.progress,
    this.lowWarning = false,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: lowWarning ? Colors.red : null),
            const SizedBox(height: 8),
            Text(label, style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 4),
            Text(
              value,
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                    color: lowWarning ? Colors.red : null,
                  ),
            ),
            if (progress != null) ...[
              const SizedBox(height: 8),
              LinearProgressIndicator(
                value: progress!.clamp(0.0, 1.0),
                color: lowWarning ? Colors.red : null,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
