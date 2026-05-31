import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../app/breakpoints.dart';
import '../../shared/models/analytics_data.dart';
import '../../shared/providers/analytics_provider.dart';
import '../../shared/providers/strategies_provider.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/metric_card.dart';
import '../../shared/widgets/skeleton.dart';

class AnalyticsDashboardScreen extends ConsumerStatefulWidget {
  const AnalyticsDashboardScreen({super.key});

  @override
  ConsumerState<AnalyticsDashboardScreen> createState() =>
      _AnalyticsDashboardScreenState();
}

class _AnalyticsDashboardScreenState
    extends ConsumerState<AnalyticsDashboardScreen> {
  String _range = '30D';
  String? _strategyId;
  String? _mode;

  AnalyticsQuery get _query => AnalyticsQuery(
        range: _range,
        strategyId: _strategyId,
        mode: _mode,
      );

  @override
  Widget build(BuildContext context) {
    final analytics = ref.watch(analyticsProvider(_query));
    final strategies = ref.watch(strategiesProvider);
    final width = MediaQuery.sizeOf(context).width;

    return Scaffold(
      appBar: AppBar(title: const Text('Analytics')),
      body: Column(
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(8),
            child: Row(
              children: [
                for (final r in ['7D', '30D', '90D', 'ALL'])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(r),
                      selected: _range == r,
                      onSelected: (_) => setState(() => _range = r),
                    ),
                  ),
              ],
            ),
          ),
          strategies.when(
            data: (list) => Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: DropdownButtonFormField<String?>(
                value: _strategyId,
                decoration: const InputDecoration(labelText: 'Strategy'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('All strategies')),
                  ...list.map(
                    (s) => DropdownMenuItem(
                      value: s.strategyId,
                      child: Text(s.name),
                    ),
                  ),
                ],
                onChanged: (v) => setState(() => _strategyId = v),
              ),
            ),
            loading: () => const SizedBox.shrink(),
            error: (_, __) => const SizedBox.shrink(),
          ),
          Expanded(
            child: analytics.when(
              data: (data) => _AnalyticsBody(data: data, wide: isWide(width)),
              loading: () => const SkeletonList(),
              error: (e, _) => ErrorState(
                error: e,
                onRetry: () => ref.invalidate(analyticsProvider(_query)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AnalyticsBody extends StatelessWidget {
  const _AnalyticsBody({required this.data, required this.wide});

  final AnalyticsData data;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    final fmt = NumberFormat.currency(symbol: '\$', decimalDigits: 2);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        SizedBox(
          height: 120,
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              SizedBox(
                width: 160,
                child: MetricCard(
                  label: 'Total P&L',
                  value: fmt.format(data.totalPnlUsd),
                  subtitle: '${data.totalPnlPct.toStringAsFixed(1)}%',
                ),
              ),
              SizedBox(
                width: 160,
                child: MetricCard(
                  label: 'Win Rate',
                  value: '${data.winRate.toStringAsFixed(0)}%',
                  subtitle: '${data.winCount}/${data.totalTrades}',
                ),
              ),
              SizedBox(
                width: 160,
                child: MetricCard(
                  label: 'Sharpe',
                  value: data.sharpeRatio?.toStringAsFixed(2) ?? '—',
                ),
              ),
              SizedBox(
                width: 160,
                child: MetricCard(
                  label: 'Max DD',
                  value: '${data.maxDrawdownPct.toStringAsFixed(1)}%',
                ),
              ),
              SizedBox(
                width: 160,
                child: MetricCard(
                  label: 'AI Cost',
                  value: fmt.format(data.claudeCostUsd),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        Text('Equity curve', style: Theme.of(context).textTheme.titleSmall),
        SizedBox(height: 200, child: _EquityChart(points: data.equityCurve)),
        const SizedBox(height: 16),
        Text('Drawdown', style: Theme.of(context).textTheme.titleSmall),
        SizedBox(height: 160, child: _DrawdownChart(points: data.drawdownSeries)),
        if (data.strategyComparison.isNotEmpty) ...[
          const SizedBox(height: 16),
          Text('Strategy comparison', style: Theme.of(context).textTheme.titleSmall),
          DataTable(
            columns: const [
              DataColumn(label: Text('Strategy')),
              DataColumn(label: Text('Trades')),
              DataColumn(label: Text('Win%')),
              DataColumn(label: Text('P&L')),
            ],
            rows: data.strategyComparison
                .map(
                  (r) => DataRow(cells: [
                    DataCell(Text(r.name)),
                    DataCell(Text('${r.trades}')),
                    DataCell(Text('${r.winRate.toStringAsFixed(0)}%')),
                    DataCell(Text(fmt.format(r.pnlUsd))),
                  ]),
                )
                .toList(),
          ),
        ],
      ],
    );
  }
}

class _EquityChart extends StatelessWidget {
  const _EquityChart({required this.points});

  final List<EquityPoint> points;

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) return const Center(child: Text('No data'));
    return LineChart(
      LineChartData(
        lineBarsData: [
          LineChartBarData(
            spots: points
                .asMap()
                .entries
                .map((e) => FlSpot(e.key.toDouble(), e.value.value))
                .toList(),
            isCurved: true,
            color: Theme.of(context).colorScheme.primary,
            dotData: const FlDotData(show: false),
          ),
        ],
        titlesData: const FlTitlesData(show: false),
      ),
    );
  }
}

class _DrawdownChart extends StatelessWidget {
  const _DrawdownChart({required this.points});

  final List<EquityPoint> points;

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) return const Center(child: Text('No data'));
    return LineChart(
      LineChartData(
        lineBarsData: [
          LineChartBarData(
            spots: points
                .asMap()
                .entries
                .map((e) => FlSpot(e.key.toDouble(), e.value.value))
                .toList(),
            isCurved: true,
            color: Colors.red,
            dotData: const FlDotData(show: false),
            belowBarData: BarAreaData(show: true, color: Colors.red.withValues(alpha: 0.2)),
          ),
        ],
        titlesData: const FlTitlesData(show: false),
      ),
    );
  }
}
