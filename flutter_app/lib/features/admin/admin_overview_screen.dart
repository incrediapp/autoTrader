import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/app_colors.dart';
import '../../app/breakpoints.dart';
import '../../shared/providers/admin_provider.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/metric_card.dart';

class AdminOverviewScreen extends ConsumerWidget {
  const AdminOverviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final metrics = ref.watch(systemMetricsProvider);
    final errors = ref.watch(adminErrorsProvider);
    final width = MediaQuery.sizeOf(context).width;
    final crossCount = isWide(width) ? 3 : 2;

    return metrics.when(
      data: (m) {
        final errorRate = m.errorRatePctToday;
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              color: errorRate > 5
                  ? AppColors.critical.withValues(alpha: 0.15)
                  : AppColors.pnlPositive.withValues(alpha: 0.15),
              child: ListTile(
                title: Text(
                  errorRate > 5
                      ? 'High error rate: ${errorRate.toStringAsFixed(1)}%'
                      : 'All systems operational',
                ),
                trailing: TextButton(
                  onPressed: () => context.go('/admin/errors'),
                  child: const Text('View errors'),
                ),
              ),
            ),
            const SizedBox(height: 16),
            GridView.count(
              crossAxisCount: crossCount,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 1.4,
              children: [
                MetricCard(
                  label: 'Users',
                  value: '${m.totalUsers}',
                  subtitle: '${m.activeUsersLast24h} active 24h',
                ),
                MetricCard(
                  label: 'Active strategies',
                  value: '${m.activeStrategies}',
                  subtitle: '${m.liveStrategies} live',
                ),
                MetricCard(
                  label: 'Trades today',
                  value: '${m.tradesToday}',
                  subtitle: '${m.liveTradesToday} live',
                ),
                MetricCard(
                  label: 'Claude cost',
                  value: '\$${m.claudeCostUsdToday.toStringAsFixed(2)}',
                  subtitle: '\$${m.claudeCostUsdThisMonth.toStringAsFixed(2)} / mo',
                ),
                MetricCard(
                  label: 'Error rate',
                  value: '${errorRate.toStringAsFixed(1)}%',
                  subtitle: '${m.errorCyclesToday} errors today',
                  valueColor: errorRate > 5 ? AppColors.critical : null,
                ),
                MetricCard(
                  label: 'Cycles today',
                  value: '${m.cyclesToday}',
                ),
              ],
            ),
            const SizedBox(height: 24),
            Text('Recent errors', style: Theme.of(context).textTheme.titleMedium),
            errors.when(
              data: (list) => Column(
                children: list.take(5).map((e) {
                  return ListTile(
                    title: Text(e.message, maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${e.source} · ${e.severity}'),
                    onTap: () => context.go('/admin/errors'),
                  );
                }).toList(),
              ),
              loading: () => const CircularProgressIndicator(),
              error: (_, __) => const SizedBox.shrink(),
            ),
            const SizedBox(height: 16),
            SizedBox(
              height: 120,
              child: BarChart(
                BarChartData(
                  barGroups: [
                    BarChartGroupData(x: 0, barRods: [BarChartRodData(toY: m.tradesToday.toDouble(), color: Colors.blue)]),
                    BarChartGroupData(x: 1, barRods: [BarChartRodData(toY: m.cyclesToday.toDouble(), color: Colors.green)]),
                  ],
                  titlesData: const FlTitlesData(show: false),
                ),
              ),
            ),
          ],
        );
      },
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => ErrorState(
        error: e,
        onRetry: () => ref.invalidate(systemMetricsProvider),
      ),
    );
  }
}
