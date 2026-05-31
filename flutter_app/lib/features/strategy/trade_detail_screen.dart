import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../shared/providers/trades_provider.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/pnl_text.dart';

class TradeDetailScreen extends ConsumerWidget {
  const TradeDetailScreen({
    super.key,
    required this.strategyId,
    required this.tradeId,
  });

  final String strategyId;
  final String tradeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tradeAsync = ref.watch(
      tradeProvider(TradeKey(strategyId: strategyId, tradeId: tradeId)),
    );

    return Scaffold(
      appBar: AppBar(title: const Text('Trade detail')),
      body: tradeAsync.when(
        data: (trade) {
          if (trade == null) return const Center(child: Text('Not found'));
          final fmt = DateFormat.yMMMd().add_Hm();
          final pm = trade.postMortem;

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Card(
                child: ListTile(
                  title: Text('${trade.side.toUpperCase()} ${trade.symbol}'),
                  subtitle: Text(
                    '${trade.executedQuantity} @ \$${trade.executedPriceUsd} · ${trade.mode}',
                  ),
                  trailing: trade.realizedPnlUsd != null
                      ? PnlText(pnl: trade.realizedPnlUsd!)
                      : null,
                ),
              ),
              ListTile(
                title: const Text('Executed'),
                trailing: Text(
                  trade.executedAt != null ? fmt.format(trade.executedAt!) : '—',
                ),
              ),
              ListTile(
                title: const Text('Fee'),
                trailing: Text('\$${trade.feeUsd.toStringAsFixed(4)}'),
              ),
              const Divider(),
              Text('Claude reasoning', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 8),
              Text(trade.claudeReasoning),
              if (pm != null && pm.generated) ...[
                const SizedBox(height: 24),
                _PostMortemCard(postMortem: pm),
              ],
            ],
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorState(error: e),
      ),
    );
  }
}

class _PostMortemCard extends StatelessWidget {
  const _PostMortemCard({required this.postMortem});

  final dynamic postMortem;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              postMortem.type == 'loss_analysis'
                  ? '📉 Post-Mortem Analysis'
                  : '📈 What Went Right',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            Text(postMortem.summary ?? ''),
            if (postMortem.signalQuality != null) ...[
              const SizedBox(height: 16),
              Text('Signal quality', style: Theme.of(context).textTheme.labelLarge),
              Text(postMortem.signalQuality!),
            ],
            if (postMortem.missedContext != null &&
                postMortem.missedContext!.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text('What could have helped',
                  style: Theme.of(context).textTheme.labelLarge),
              ...postMortem.missedContext!.map((c) => Text('• $c')),
            ],
            if (postMortem.lessonsForStrategy != null &&
                postMortem.lessonsForStrategy!.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text('Lessons for strategy',
                  style: Theme.of(context).textTheme.labelLarge),
              ...postMortem.lessonsForStrategy!.map((c) => Text('• $c')),
            ],
          ],
        ),
      ),
    );
  }
}
