import 'package:flutter/material.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../app/app_colors.dart';
import '../models/cycle_model.dart';

class CycleEntryCard extends StatelessWidget {
  const CycleEntryCard({super.key, required this.cycle, this.onTap});

  final CycleModel cycle;
  final VoidCallback? onTap;

  Color get _actionColor {
    if (cycle.error) return AppColors.warning;
    return switch (cycle.decision.action) {
      'buy' => AppColors.pnlPositive,
      'sell' => AppColors.critical,
      'suggest_asset' => Colors.purple,
      _ => Colors.blue,
    };
  }

  IconData get _actionIcon {
    if (cycle.error) return Icons.error_outline;
    return switch (cycle.decision.action) {
      'buy' => Icons.arrow_upward,
      'sell' => Icons.arrow_downward,
      'suggest_asset' => Icons.lightbulb_outline,
      _ => Icons.pause_circle_outline,
    };
  }

  @override
  Widget build(BuildContext context) {
    final reasoning = cycle.error
        ? (cycle.errorMessage ?? 'Error')
        : (cycle.decision.reasoning ?? 'No reasoning');
    final when = cycle.startedAt != null
        ? timeago.format(cycle.startedAt!, locale: 'en_short')
        : '';

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(_actionIcon, color: _actionColor, size: 20),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          cycle.decision.action.toUpperCase(),
                          style: TextStyle(
                            color: _actionColor,
                            fontWeight: FontWeight.bold,
                            fontSize: 12,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(when, style: Theme.of(context).textTheme.labelSmall),
                        if (cycle.decision.confidence != null) ...[
                          const Spacer(),
                          Text(
                            'conf: ${cycle.decision.confidence!.toStringAsFixed(2)}',
                            style: Theme.of(context).textTheme.labelSmall,
                          ),
                        ],
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      reasoning,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}
