import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/cloud_functions.dart';
import '../../shared/models/conflict_log_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/widgets/confidence_bar.dart';

void showConflictResolutionSheet(
  BuildContext context,
  WidgetRef ref,
  ConflictLogModel conflict,
) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => Consumer(
      builder: (_, ref, __) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(ctx).bottom + 24,
          left: 24,
          right: 24,
          top: 24,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Strategy Conflict Detected',
              style: Theme.of(ctx).textTheme.titleLarge,
            ),
            Text('Both strategies want to trade ${conflict.symbol}'),
            const SizedBox(height: 16),
            _SideCard(
              name: conflict.strategyAName,
              decision: conflict.strategyADecision,
            ),
            _SideCard(
              name: conflict.strategyBName,
              decision: conflict.strategyBDecision,
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: () => _resolve(ref, ctx, conflict.conflictId, 'executed_a'),
              child: Text('Execute ${conflict.strategyAName}'),
            ),
            FilledButton(
              onPressed: () => _resolve(ref, ctx, conflict.conflictId, 'executed_b'),
              child: Text('Execute ${conflict.strategyBName}'),
            ),
            OutlinedButton(
              onPressed: () => _resolve(ref, ctx, conflict.conflictId, 'held_both'),
              child: const Text('Hold both'),
            ),
          ],
        ),
      ),
    ),
  );
}

Future<void> _resolve(
  WidgetRef ref,
  BuildContext ctx,
  String conflictId,
  String resolution,
) async {
  try {
    await ref.read(cloudFunctionsProvider).resolveConflict(
          conflictId: conflictId,
          resolution: resolution,
        );
    if (ctx.mounted) Navigator.pop(ctx);
  } on FirebaseFunctionsException catch (e) {
    if (ctx.mounted) {
      ScaffoldMessenger.of(ctx).showSnackBar(
        SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message))),
      );
    }
  }
}

class _SideCard extends StatelessWidget {
  const _SideCard({required this.name, required this.decision});

  final String name;
  final ConflictDecision decision;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(name, style: Theme.of(context).textTheme.titleSmall),
            Text(
              '${decision.side.toUpperCase()} \$${decision.notionalUsd.toStringAsFixed(2)}',
            ),
            Text(decision.reasoning),
            ConfidenceBar(confidence: decision.confidence),
          ],
        ),
      ),
    );
  }
}
