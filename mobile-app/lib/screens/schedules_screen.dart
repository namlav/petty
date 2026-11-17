import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/schedule.dart';
import '../state/app_state.dart';

/// [SV3: T-SV3-06] Quản lý tối đa 4 lịch hẹn đồng bộ xuống ESP32.
class SchedulesScreen extends StatefulWidget {
  const SchedulesScreen({super.key});

  @override
  State<SchedulesScreen> createState() => _SchedulesScreenState();
}

class _SchedulesScreenState extends State<SchedulesScreen> {
  Future<void> _addOrEditDialog(
    BuildContext context,
    AppState state, {
    int? index,
    FeedingScheduleItem? initial,
  }) async {
    TimeOfDay picked = TimeOfDay(
      hour: initial?.hour ?? 7,
      minute: initial?.minute ?? 30,
    );
    double grams = initial?.grams ?? 30;
    bool enabled = initial?.enabled ?? true;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          title: Text(index == null ? 'Thêm lịch cho ăn' : 'Sửa lịch cho ăn'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Giờ cho ăn'),
                trailing: TextButton(
                  onPressed: () async {
                    final result = await showTimePicker(
                      context: ctx,
                      initialTime: picked,
                    );
                    if (result != null) {
                      setLocal(() => picked = result);
                    }
                  },
                  child: Text(picked.format(ctx)),
                ),
              ),
              Row(
                children: [
                  const Text('Khẩu phần:'),
                  Expanded(
                    child: Slider(
                      value: grams,
                      min: 10,
                      max: 200,
                      divisions: 19,
                      label: '${grams.toInt()} g',
                      onChanged: (v) => setLocal(() => grams = v),
                    ),
                  ),
                  Text('${grams.toInt()} g'),
                ],
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Bật lịch'),
                value: enabled,
                onChanged: (v) => setLocal(() => enabled = v),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Huỷ'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Lưu'),
            ),
          ],
        ),
      ),
    );

    if (confirmed != true) return;
    final updated = List<FeedingScheduleItem>.from(state.schedules);
    final item = FeedingScheduleItem(
      hour: picked.hour,
      minute: picked.minute,
      grams: grams,
      enabled: enabled,
    );
    if (index == null) {
      updated.add(item);
    } else {
      updated[index] = item;
    }
    if (!context.mounted) return;
    await _saveWithFeedback(context, state, updated);
  }

  Future<void> _saveWithFeedback(
    BuildContext context,
    AppState state,
    List<FeedingScheduleItem> items,
  ) async {
    try {
      await state.saveSchedules(items);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Đã lưu lịch cho ăn')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Lỗi lưu lịch: $e')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final canControl = state.session?.canControl ?? false;
    final items = state.schedules;

    return Scaffold(
      body: items.isEmpty
          ? const Center(child: Text('Chưa có lịch hẹn nào'))
          : ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: items.length,
              separatorBuilder: (context, index) => const SizedBox(height: 8),
              itemBuilder: (ctx, i) {
                final item = items[i];
                return Card(
                  child: ListTile(
                    leading: const Icon(Icons.alarm),
                    title: Text('${item.formattedTime} · ${item.grams.toInt()} g'),
                    subtitle: Text(item.enabled ? 'Đang bật' : 'Đang tắt'),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Switch(
                          value: item.enabled,
                          onChanged: canControl
                              ? (val) {
                                  final copy = List<FeedingScheduleItem>.from(items);
                                  copy[i] = item.copyWith(enabled: val);
                                  _saveWithFeedback(context, state, copy);
                                }
                              : null,
                        ),
                        if (canControl)
                          IconButton(
                            icon: const Icon(Icons.edit_outlined),
                            onPressed: () => _addOrEditDialog(
                              context,
                              state,
                              index: i,
                              initial: item,
                            ),
                          ),
                        if (canControl)
                          IconButton(
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () {
                              final copy = List<FeedingScheduleItem>.from(items)
                                ..removeAt(i);
                              _saveWithFeedback(context, state, copy);
                            },
                          ),
                      ],
                    ),
                  ),
                );
              },
            ),
      floatingActionButton: canControl && items.length < 4
          ? FloatingActionButton.extended(
              onPressed: () => _addOrEditDialog(context, state),
              icon: const Icon(Icons.add_alarm),
              label: const Text('Thêm lịch'),
            )
          : null,
    );
  }
}
