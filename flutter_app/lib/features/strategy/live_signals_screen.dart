import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../app/app_colors.dart';
import '../../services/cloud_functions.dart';
import '../../shared/models/cycle_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/cycles_provider.dart';
import '../../shared/providers/strategies_provider.dart';

class LiveSignalsScreen extends ConsumerWidget {
  const LiveSignalsScreen({super.key, required this.strategyId});

  final String strategyId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final strategy = ref.watch(strategyProvider(strategyId));
    final latest = ref.watch(latestCycleProvider(strategyId));

    return Scaffold(
      appBar: AppBar(title: const Text('Live Signals')),
      body: strategy.when(
        data: (s) {
          if (s == null) return const Center(child: Text('Strategy not found'));
          return latest.when(
            data: (cycle) {
              if (cycle == null) {
                return const Center(child: Text('No cycle data yet'));
              }
              return ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Data from last cycle: ${cycle.startedAt != null ? timeago.format(cycle.startedAt!) : '—'}',
                        ),
                      ),
                      FilledButton.tonal(
                        onPressed: () => _runNow(ref, context),
                        child: const Text('Run now'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  ...cycle.marketSnapshot.assets.map(
                    (a) => _AssetSignalCard(asset: a, rules: s.rules),
                  ),
                  const SizedBox(height: 16),
                  Text('Rules watching', style: Theme.of(context).textTheme.titleSmall),
                  ...s.rules.where((r) => r.active).map(
                        (r) => ListTile(
                          dense: true,
                          title: Text(r.ruleId),
                          subtitle: Text('${r.condition} → ${r.action}'),
                        ),
                      ),
                ],
              );
            },
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Text('$e')),
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
      ),
    );
  }

  Future<void> _runNow(WidgetRef ref, BuildContext context) async {
    try {
      await ref.read(cloudFunctionsProvider).manualCycleTrigger(strategyId);
    } on FirebaseFunctionsException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message))),
        );
      }
    }
  }
}

class _AssetSignalCard extends StatelessWidget {
  const _AssetSignalCard({required this.asset, required this.rules});

  final MarketAssetSnapshot asset;
  final List<dynamic> rules;

  @override
  Widget build(BuildContext context) {
    final rsi = asset.rsi14;
    final threshold = 30.0;
    final proximity = rsi != null ? (rsi - threshold).abs() : null;
    final color = rsi != null && rsi < threshold
        ? AppColors.pnlPositive
        : proximity != null && proximity < 6
            ? AppColors.warning
            : Colors.blue;

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(asset.symbol, style: Theme.of(context).textTheme.titleMedium),
                Text('\$${asset.price.toStringAsFixed(2)}'),
              ],
            ),
            if (rsi != null) ...[
              const SizedBox(height: 8),
              Text('RSI(14) ${rsi.toStringAsFixed(1)} → need < $threshold'),
              const SizedBox(height: 4),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: (rsi / 100).clamp(0, 1),
                  color: color,
                  minHeight: 8,
                ),
              ),
              if (proximity != null && proximity < 3)
                Text('⚠️ Getting close!', style: TextStyle(color: color)),
            ],
            if (asset.earningsContext != null) ...[
              const SizedBox(height: 8),
              Text(
                '⚠️ Earnings in ${asset.earningsContext!['daysUntil']} days',
                style: const TextStyle(color: AppColors.warning),
              ),
            ],
            if (asset.macdHistogram != null)
              Text('MACD hist ${asset.macdHistogram!.toStringAsFixed(4)}'),
          ],
        ),
      ),
    );
  }
}
