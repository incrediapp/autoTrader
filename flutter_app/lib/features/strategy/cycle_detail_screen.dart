import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../shared/providers/cycles_provider.dart';
import '../../shared/widgets/confidence_bar.dart';
import '../../shared/widgets/error_state.dart';

class CycleDetailScreen extends ConsumerWidget {
  const CycleDetailScreen({
    super.key,
    required this.strategyId,
    required this.cycleId,
  });

  final String strategyId;
  final String cycleId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cycleAsync = ref.watch(
      cycleProvider(CycleKey(strategyId: strategyId, cycleId: cycleId)),
    );

    return Scaffold(
      appBar: AppBar(title: const Text('Cycle detail')),
      body: cycleAsync.when(
        data: (cycle) {
          if (cycle == null) return const Center(child: Text('Not found'));
          final fmt = DateFormat.yMMMd().add_Hm();
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              ListTile(
                title: Text(cycle.decision.action.toUpperCase()),
                subtitle: Text(
                  cycle.startedAt != null ? fmt.format(cycle.startedAt!) : '',
                ),
              ),
              ExpansionTile(
                title: const Text('Decision'),
                initiallyExpanded: true,
                children: [
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(cycle.decision.reasoning ?? 'No reasoning'),
                  ),
                  if (cycle.decision.confidence != null)
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: ConfidenceBar(confidence: cycle.decision.confidence!),
                    ),
                  if (cycle.rulesTriggered != null)
                    ...cycle.rulesTriggered!.map((r) => ListTile(title: Text(r))),
                ],
              ),
              ExpansionTile(
                title: const Text('Market snapshot'),
                children: cycle.marketSnapshot.assets
                    .map(
                      (a) => ListTile(
                        title: Text(a.symbol),
                        subtitle: Text(
                          'Price \$${a.price.toStringAsFixed(2)} · RSI ${a.rsi14?.toStringAsFixed(1) ?? '—'}',
                        ),
                      ),
                    )
                    .toList(),
              ),
              ExpansionTile(
                title: const Text('Portfolio at cycle time'),
                children: [
                  ListTile(
                    title: Text(
                      '\$${cycle.portfolioSnapshot.totalValueUsd.toStringAsFixed(2)}',
                    ),
                    subtitle: Text(
                      'Cash \$${cycle.portfolioSnapshot.cashUsd.toStringAsFixed(2)}',
                    ),
                  ),
                  ...cycle.portfolioSnapshot.positions.map(
                    (p) => ListTile(
                      title: Text(p.symbol),
                      subtitle: Text('${p.quantity} @ \$${p.avgCostUsd}'),
                    ),
                  ),
                ],
              ),
              if (cycle.tradeId != null)
                ListTile(
                  title: const Text('Trade executed'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push(
                    '/dashboard/strategy/$strategyId/trade/${cycle.tradeId}',
                  ),
                ),
              ExpansionTile(
                title: const Text('Claude raw response'),
                children: [
                  SelectableText(cycle.claudeRawResponse ?? 'N/A'),
                ],
              ),
            ],
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorState(error: e),
      ),
    );
  }
}
