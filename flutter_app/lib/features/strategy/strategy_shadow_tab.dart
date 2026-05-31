import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/models/shadow_config_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/strategies_provider.dart';
import '../../shared/widgets/hold_to_confirm_button.dart';
import '../../shared/widgets/pnl_text.dart';

class StrategyShadowTab extends ConsumerWidget {
  const StrategyShadowTab({super.key, required this.strategyId});

  final String strategyId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final shadows = ref.watch(shadowConfigsProvider(strategyId));

    return shadows.when(
      data: (list) => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Shadow Mode', style: Theme.of(context).textTheme.titleLarge),
              TextButton(
                onPressed: () {},
                child: const Text('+ Add Shadow'),
              ),
            ],
          ),
          ...list.map((s) => _ShadowCard(shadow: s, strategyId: strategyId)),
        ],
      ),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('$e')),
    );
  }
}

class _ShadowCard extends ConsumerWidget {
  const _ShadowCard({required this.shadow, required this.strategyId});

  final ShadowConfigModel shadow;
  final String strategyId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(shadow.name, style: Theme.of(context).textTheme.titleMedium),
                ),
                Chip(label: Text(shadow.status)),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                const Text('Live P&L: '),
                PnlText(pnl: shadow.stats.parentTotalPnlUsd),
              ],
            ),
            Row(
              children: [
                const Text('Shadow P&L: '),
                PnlText(pnl: shadow.stats.shadowTotalPnlUsd),
                if (shadow.stats.outperforming)
                  const Text(' ↑ better', style: TextStyle(color: Colors.green)),
              ],
            ),
            Text(
              'Shadow: ${shadow.stats.totalShadowTrades} trades · Live comparison',
            ),
            const SizedBox(height: 12),
            HoldToConfirmButton(
              label: 'Promote shadow to live',
              color: Theme.of(context).colorScheme.primary,
              onConfirmed: () async {
                await ref.read(cloudFunctionsProvider).promoteShadowConfig(
                      strategyId: strategyId,
                      shadowId: shadow.shadowId,
                    );
              },
            ),
          ],
        ),
      ),
    );
  }
}
