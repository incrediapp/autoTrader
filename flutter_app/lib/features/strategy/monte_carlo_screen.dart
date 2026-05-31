import 'package:cloud_functions/cloud_functions.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/cloud_functions.dart';
import '../../shared/models/monte_carlo_result_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';

class MonteCarloScreen extends ConsumerStatefulWidget {
  const MonteCarloScreen({super.key, required this.strategyId});

  final String strategyId;

  @override
  ConsumerState<MonteCarloScreen> createState() => _MonteCarloScreenState();
}

class _MonteCarloScreenState extends ConsumerState<MonteCarloScreen> {
  MonteCarloResultModel? _result;
  bool _loading = false;
  double _capital = 20;
  int _days = 90;

  Future<void> _run() async {
    setState(() => _loading = true);
    try {
      final raw = await ref.read(cloudFunctionsProvider).runMonteCarlo(
            strategyId: widget.strategyId,
            startingCapitalUsd: _capital,
            periodDays: _days,
          );
      setState(() {
        _result = MonteCarloResultModel.fromJson({
          ...raw,
          'results': raw['results'] ?? raw,
          'dataSource': raw['dataSource'],
          'tradesUsedForParams': raw['tradesUsedForParams'],
        });
      });
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message))),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _result?.results;
    return Scaffold(
      appBar: AppBar(title: const Text('Risk Simulation')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                TextField(
                  decoration: const InputDecoration(labelText: 'Starting capital (\$)'),
                  keyboardType: TextInputType.number,
                  onChanged: (v) => _capital = double.tryParse(v) ?? 20,
                ),
                DropdownButtonFormField(
                  value: _days,
                  decoration: const InputDecoration(labelText: 'Period'),
                  items: const [
                    DropdownMenuItem(value: 30, child: Text('30 days')),
                    DropdownMenuItem(value: 90, child: Text('90 days')),
                    DropdownMenuItem(value: 180, child: Text('180 days')),
                  ],
                  onChanged: (v) => setState(() => _days = v!),
                ),
                FilledButton(onPressed: _run, child: const Text('Run simulation')),
                if (r != null) ...[
                  const SizedBox(height: 24),
                  if (_result!.dataSource == 'manual_params')
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text(
                          'Using default assumptions (${_result!.tradesUsedForParams} closing paper trades found; need 20+ for history-based params).',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                    ),
                  Text('Projected outcomes', style: Theme.of(context).textTheme.titleMedium),
                  _percentileRow('Worst 5%', r.p5FinalValueUsd, _capital),
                  _percentileRow('Median', r.p50FinalValueUsd, _capital),
                  _percentileRow('Best 5%', r.p95FinalValueUsd, _capital),
                  const SizedBox(height: 16),
                  Text('Lose > 20%: ${(r.probabilityOfRuin20Pct * 100).toStringAsFixed(0)}%'),
                  Text('Lose > 50%: ${(r.probabilityOfRuin50Pct * 100).toStringAsFixed(0)}%'),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 200,
                    child: _EquitySpaghettiChart(curves: r.equityCurves),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 160,
                    child: _ReturnsHistogramChart(histogram: r.returnsHistogram),
                  ),
                  const Text(
                    'Past results do not guarantee future performance.',
                    style: TextStyle(fontSize: 12),
                  ),
                ],
              ],
            ),
    );
  }

  Widget _percentileRow(String label, double value, double start) {
    final pct = ((value - start) / start) * 100;
    return ListTile(
      title: Text(label),
      trailing: Text('\$${value.toStringAsFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toStringAsFixed(0)}%)'),
    );
  }
}

class _EquitySpaghettiChart extends StatelessWidget {
  const _EquitySpaghettiChart({required this.curves});

  final List<List<double>> curves;

  @override
  Widget build(BuildContext context) {
    if (curves.isEmpty) return const Center(child: Text('No curve data'));
    final lines = curves.take(20).map((curve) {
      return LineChartBarData(
        spots: curve
            .asMap()
            .entries
            .map((e) => FlSpot(e.key.toDouble(), e.value))
            .toList(),
        isCurved: true,
        dotData: const FlDotData(show: false),
        color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.4),
        barWidth: 1,
      );
    }).toList();

    return LineChart(LineChartData(lineBarsData: lines, gridData: const FlGridData(show: false)));
  }
}

class _ReturnsHistogramChart extends StatelessWidget {
  const _ReturnsHistogramChart({required this.histogram});

  final dynamic histogram;

  @override
  Widget build(BuildContext context) {
    final counts = histogram.counts as List<int>? ?? [];
    if (counts.isEmpty) return const Center(child: Text('No histogram'));
    return BarChart(
      BarChartData(
        barGroups: counts
            .asMap()
            .entries
            .map(
              (e) => BarChartGroupData(
                x: e.key,
                barRods: [
                  BarChartRodData(
                    toY: e.value.toDouble(),
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ],
              ),
            )
            .toList(),
        titlesData: const FlTitlesData(show: false),
        gridData: const FlGridData(show: false),
      ),
    );
  }
}
