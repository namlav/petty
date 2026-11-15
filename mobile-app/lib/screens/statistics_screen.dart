import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';

/// [SV3: T-SV3-05 / T-SV3-06] Biểu đồ thống kê fl_chart (live & lịch sử DB).
class StatisticsScreen extends StatelessWidget {
  const StatisticsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final live = state.liveTelemetry;
    final stats = state.stats;

    return RefreshIndicator(
      onRefresh: () => state.loadStats(state.statsRange),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: '24h', label: Text('24 giờ')),
              ButtonSegment(value: '7d', label: Text('7 ngày')),
              ButtonSegment(value: '30d', label: Text('30 ngày')),
            ],
            selected: {state.statsRange},
            onSelectionChanged: (sel) => state.loadStats(sel.first),
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Lượng thức ăn tiêu thụ (${state.statsRange})',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 200,
                    child: stats.isEmpty
                        ? const Center(child: Text('Chưa có dữ liệu thống kê'))
                        : BarChart(
                            BarChartData(
                              borderData: FlBorderData(show: false),
                              titlesData: FlTitlesData(
                                topTitles: const AxisTitles(
                                  sideTitles: SideTitles(showTitles: false),
                                ),
                                rightTitles: const AxisTitles(
                                  sideTitles: SideTitles(showTitles: false),
                                ),
                                bottomTitles: AxisTitles(
                                  sideTitles: SideTitles(
                                    showTitles: true,
                                    getTitlesWidget: (val, meta) {
                                      final idx = val.toInt();
                                      if (idx < 0 || idx >= stats.length) {
                                        return const SizedBox.shrink();
                                      }
                                      final fmt = state.statsRange == '24h'
                                          ? DateFormat('HH')
                                          : DateFormat('dd/MM');
                                      return Text(
                                        fmt.format(stats[idx].bucket.toLocal()),
                                        style: const TextStyle(fontSize: 10),
                                      );
                                    },
                                  ),
                                ),
                              ),
                              barGroups: [
                                for (var i = 0; i < stats.length; i++)
                                  BarChartGroupData(
                                    x: i,
                                    barRods: [
                                      BarChartRodData(
                                        toY: stats[i].eatenG,
                                        width: 14,
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                    ],
                                  ),
                              ],
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Biến động khối lượng khay (realtime)',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 180,
                    child: live.isEmpty
                        ? const Center(child: Text('Đang chờ telemetry từ thiết bị...'))
                        : LineChart(
                            LineChartData(
                              borderData: FlBorderData(show: false),
                              titlesData: const FlTitlesData(
                                topTitles: AxisTitles(
                                  sideTitles: SideTitles(showTitles: false),
                                ),
                                rightTitles: AxisTitles(
                                  sideTitles: SideTitles(showTitles: false),
                                ),
                              ),
                              lineBarsData: [
                                LineChartBarData(
                                  isCurved: true,
                                  dotData: const FlDotData(show: false),
                                  spots: [
                                    for (var i = 0; i < live.length; i++)
                                      FlSpot(i.toDouble(), live[i].weightG),
                                  ],
                                ),
                              ],
                            ),
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
