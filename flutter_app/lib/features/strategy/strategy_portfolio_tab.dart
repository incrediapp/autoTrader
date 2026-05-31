import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../services/cloud_functions.dart';
import '../../shared/models/position_model.dart';
import '../../shared/models/strategy_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/cycles_provider.dart';
import '../../shared/providers/strategies_provider.dart' show positionsProvider;
import '../../shared/widgets/pnl_text.dart';
import '../calendar/earnings_calendar_widget.dart';

class StrategyPortfolioTab extends ConsumerWidget {
  const StrategyPortfolioTab({
    super.key,
    required this.strategyId,
    required this.strategy,
  });

  final String strategyId;
  final StrategyModel strategy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final positions = ref.watch(positionsProvider(strategyId));
    final latestCycle = ref.watch(latestCycleProvider(strategyId));

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (strategy.assets.broker == 'ibkr')
          EarningsCalendarWidget(symbols: strategy.assets.watchlist),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Portfolio', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                PnlText(pnl: strategy.stats.totalRealizedPnlUsd),
                const SizedBox(height: 8),
                latestCycle.when(
                  data: (cycle) {
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (cycle == null)
                          const Text('No cycles yet')
                        else
                          Text(
                            'Last: ${cycle.decision.action.toUpperCase()} — ${cycle.decision.reasoning ?? ''}',
                          ),
                        const SizedBox(height: 8),
                        FilledButton.tonalIcon(
                          onPressed: () => _runNow(ref, context),
                          icon: const Icon(Icons.play_arrow),
                          label: const Text('Run now'),
                        ),
                      ],
                    );
                  },
                  loading: () => const LinearProgressIndicator(),
                  error: (_, __) => FilledButton.tonalIcon(
                    onPressed: () => _runNow(ref, context),
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Run now'),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        Text('Open positions', style: Theme.of(context).textTheme.titleSmall),
        positions.when(
          data: (list) => list.isEmpty
              ? const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('No open positions'),
                )
              : Column(
                  children: list.map((p) => _PositionTile(p)).toList(),
                ),
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Text('Error: $e'),
        ),
      ],
    );
  }

  Future<void> _runNow(WidgetRef ref, BuildContext context) async {
    try {
      final result = await ref
          .read(cloudFunctionsProvider)
          .manualCycleTrigger(strategyId);
      if (!context.mounted) return;

      if (result['skipped'] == true) {
        final reason = result['skippedReason']?.toString() ?? 'unknown';
        final detail = result['errorMessage']?.toString();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              detail != null && detail.isNotEmpty
                  ? 'Cycle skipped ($reason): $detail'
                  : 'Cycle skipped: $reason',
            ),
            duration: const Duration(seconds: 8),
          ),
        );
        return;
      }

      final action = result['decision']?['action']?.toString();
      final parseError = result['claudeParseError']?.toString();
      if (parseError != null && parseError.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Cycle held — Claude parse issue: $parseError'),
            duration: const Duration(seconds: 10),
          ),
        );
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            result['tradeExecuted'] == true
                ? 'Trade executed (${action ?? 'buy/sell'})'
                : 'Cycle complete: ${action ?? 'hold'}',
          ),
        ),
      );
    } on FirebaseFunctionsException catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(friendlyCloudFunctionError(e.code, e.message)),
          ),
        );
      }
    }
  }
}

class _PositionTile extends StatelessWidget {
  const _PositionTile(this.position);

  final PositionModel position;

  @override
  Widget build(BuildContext context) {
    final fmt = NumberFormat.currency(symbol: '\$', decimalDigits: 2);
    return Card(
      child: ListTile(
        title: Text(position.symbol),
        subtitle: Text(
          '${position.quantity} @ avg ${fmt.format(position.avgCostUsd)}',
        ),
        trailing: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(fmt.format(position.currentValueUsd)),
            PnlText(pnl: position.unrealizedPnlUsd, showPercent: true, pct: position.unrealizedPnlPct),
          ],
        ),
      ),
    );
  }
}
