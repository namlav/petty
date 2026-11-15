import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';

/// [SV3: T-SV3-06] Cài đặt thiết bị, URL Gateway & đăng xuất.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  late final TextEditingController _httpCtrl;
  late final TextEditingController _wsCtrl;

  @override
  void initState() {
    super.initState();
    final state = context.read<AppState>();
    _httpCtrl = TextEditingController(text: state.gatewayHttpUrl);
    _wsCtrl = TextEditingController(text: state.gatewayWsUrl);
  }

  @override
  void dispose() {
    _httpCtrl.dispose();
    _wsCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final session = state.session;
    final deviceIds = {
      state.selectedDeviceId,
      ...state.devices.map((d) => d.id),
    }.toList();

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: ListTile(
            leading: const Icon(Icons.person_outline),
            title: Text(session?.email ?? '-'),
            subtitle: Text('Vai trò: ${session?.role ?? '-'}'),
            trailing: OutlinedButton(
              onPressed: state.signOut,
              child: const Text('Đăng xuất'),
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Thiết bị & Gateway',
                    style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: state.selectedDeviceId,
                  decoration: const InputDecoration(
                    labelText: 'Thiết bị đang theo dõi',
                    border: OutlineInputBorder(),
                  ),
                  items: deviceIds
                      .map((id) => DropdownMenuItem(value: id, child: Text(id)))
                      .toList(),
                  onChanged: (v) {
                    if (v != null) state.selectDevice(v);
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _httpCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Gateway HTTP URL',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _wsCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Gateway WebSocket URL',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () {
                    state.updateGatewayUrls(
                      httpUrl: _httpCtrl.text,
                      wsUrl: _wsCtrl.text,
                    );
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Đã cập nhật URL Gateway')),
                    );
                  },
                  child: const Text('Áp dụng & Kết nối lại'),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
