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
  late final TextEditingController _bowlCapCtrl;
  String? _syncedDeviceId;
  double? _syncedBowlCap;
  bool _savingConfig = false;

  @override
  void initState() {
    super.initState();
    final state = context.read<AppState>();
    _httpCtrl = TextEditingController(text: state.gatewayHttpUrl);
    _wsCtrl = TextEditingController(text: state.gatewayWsUrl);
    _syncedDeviceId = state.selectedDeviceId;
    _syncedBowlCap = state.bowlCapacityG;
    _bowlCapCtrl = TextEditingController(text: state.bowlCapacityG.toStringAsFixed(0));
  }

  @override
  void dispose() {
    _httpCtrl.dispose();
    _wsCtrl.dispose();
    _bowlCapCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final session = state.session;
    final canControl = session?.canControl ?? false;
    if (state.selectedDeviceId != _syncedDeviceId ||
        state.bowlCapacityG != _syncedBowlCap) {
      final currentCap = _syncedBowlCap?.toStringAsFixed(0);
      if (state.selectedDeviceId != _syncedDeviceId ||
          _bowlCapCtrl.text == currentCap) {
        _bowlCapCtrl.text = state.bowlCapacityG.toStringAsFixed(0);
      }
      _syncedDeviceId = state.selectedDeviceId;
      _syncedBowlCap = state.bowlCapacityG;
    }
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
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _bowlCapCtrl,
                        enabled: canControl && !_savingConfig,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                          labelText: 'Dung tích bát tối đa (50–1000 g)',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    FilledButton.tonal(
                      onPressed: canControl && !_savingConfig
                          ? () async {
                              final cap = double.tryParse(_bowlCapCtrl.text.trim());
                              if (cap == null || cap < 50 || cap > 1000) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('Dung tích bát phải từ 50 đến 1000 g'),
                                  ),
                                );
                                return;
                              }
                              setState(() => _savingConfig = true);
                              try {
                                final saved = await state.updateBowlCapacity(cap);
                                if (!context.mounted) return;
                                _bowlCapCtrl.text = saved.toStringAsFixed(0);
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text('Đã lưu dung tích bát: ${saved.toStringAsFixed(0)} g'),
                                  ),
                                );
                              } catch (e) {
                                if (!context.mounted) return;
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(content: Text('Lỗi: $e')),
                                );
                              } finally {
                                if (mounted) setState(() => _savingConfig = false);
                              }
                            }
                          : null,
                      child: const Text('Lưu bát'),
                    ),
                  ],
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
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  children: [
                    ActionChip(
                      label: const Text('USB (adb reverse 127.0.0.1)'),
                      onPressed: () {
                        _httpCtrl.text = 'http://127.0.0.1:8080';
                        _wsCtrl.text = 'ws://127.0.0.1:8080/ws';
                      },
                    ),
                    ActionChip(
                      label: const Text('Emulator (10.0.2.2)'),
                      onPressed: () {
                        _httpCtrl.text = 'http://10.0.2.2:8080';
                        _wsCtrl.text = 'ws://10.0.2.2:8080/ws';
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () async {
                    await state.updateGatewayUrls(
                      httpUrl: _httpCtrl.text,
                      wsUrl: _wsCtrl.text,
                    );
                    if (!context.mounted) return;
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
