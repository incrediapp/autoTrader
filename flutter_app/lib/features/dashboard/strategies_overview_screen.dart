import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:timeago/timeago.dart' as timeago;

import '../../services/cloud_functions.dart';
import '../../shared/models/strategy_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/strategies_provider.dart';
import '../../shared/providers/user_provider.dart';
import '../../shared/widgets/mode_badge.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/pnl_text.dart';
import '../../shared/widgets/skeleton.dart';
import '../../shared/widgets/status_dot.dart';

class StrategiesOverviewScreen extends ConsumerWidget {
  const StrategiesOverviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final strategiesAsync = ref.watch(strategiesProvider);
    final user = ref.watch(userProvider).valueOrNull;

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Strategies'),
        actions: [
          if (user?.isAdmin == true)
            IconButton(
              icon: const Icon(Icons.admin_panel_settings),
              onPressed: () => context.go('/admin'),
            ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.go('/dashboard/new-strategy'),
        child: const Icon(Icons.add),
      ),
      body: strategiesAsync.when(
        data: (strategies) {
          return RefreshIndicator(
            onRefresh: () async {
              try {
                await ref.read(cloudFunctionsProvider).syncStrategyStats();
              } on FirebaseFunctionsException catch (_) {
                // Firestore stream still refreshes below.
              }
              ref.invalidate(strategiesProvider);
            },
            child: Column(
              children: [
                if (user != null && !user.brokers.hasAnyBroker)
                  MaterialBanner(
                    content: const Text(
                      'Connect a broker to start trading.',
                    ),
                    actions: [
                      TextButton(
                        onPressed: () => context.go('/settings/brokers'),
                        child: const Text('Connect'),
                      ),
                    ],
                  ),
                Expanded(
                  child: strategies.isEmpty
                      ? EmptyState(
                          title: 'No strategies yet',
                          subtitle:
                              'Your first strategy is one conversation away.',
                          ctaLabel: 'Create Strategy',
                          onCta: () => context.go('/dashboard/new-strategy'),
                        )
                      : ListView.builder(
                          itemCount: strategies.length,
                          itemBuilder: (_, i) => _StrategyCard(
                            strategy: strategies[i],
                          ),
                        ),
                ),
              ],
            ),
          );
        },
        loading: () => const SkeletonList(),
        error: (e, _) => ErrorState(
          error: e,
          onRetry: () => ref.invalidate(strategiesProvider),
        ),
      ),
    );
  }
}

double _cycleIntervalProgress(StrategyModel strategy) {
  final last = strategy.lastCycleAt;
  if (last == null) return 0;
  final intervalMs = strategy.schedule.checkIntervalMinutes * 60 * 1000;
  if (intervalMs <= 0) return 0;
  final elapsed = DateTime.now().difference(last).inMilliseconds;
  return (elapsed / intervalMs).clamp(0.0, 1.0);
}

String _nextCheckLabel(StrategyModel strategy) {
  if (strategy.lastCycleAt == null) {
    return 'First scheduled check pending';
  }
  final next = strategy.lastCycleAt!.add(
    Duration(minutes: strategy.schedule.checkIntervalMinutes),
  );
  final remaining = next.difference(DateTime.now());
  if (remaining.isNegative) return 'Due now';
  if (remaining.inSeconds < 60) return 'Next check <1 min';
  return 'Next check ~${remaining.inMinutes} min';
}

class _StrategyCard extends ConsumerWidget {
  const _StrategyCard({required this.strategy});

  final StrategyModel strategy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pendingAutopilot =
        ref.watch(pendingAutopilotProvider(strategy.strategyId));

    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: InkWell(
        onTap: () => context.go('/dashboard/strategy/${strategy.strategyId}'),
        onLongPress: () => _showActions(context, ref),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  StatusDot(status: strategy.status),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      strategy.name,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ),
                  if (pendingAutopilot != null)
                    const Padding(
                      padding: EdgeInsets.only(right: 4),
                      child: Text('✨', style: TextStyle(fontSize: 16)),
                    ),
                  ModeBadge(mode: strategy.mode),
                  const SizedBox(width: 4),
                  DecisionModeBadge(mode: strategy.decisionMode),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                '${strategy.assets.broker == 'ibkr' ? 'IBKR' : 'Binance'} · ${strategy.assets.watchlist.join(', ')}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 12),
              PnlText(
                pnl: strategy.stats.totalRealizedPnlUsd,
                showPercent: strategy.stats.peakPortfolioValueUsd > 0,
                pct: strategy.stats.peakPortfolioValueUsd > 0
                    ? (strategy.stats.totalRealizedPnlUsd /
                            strategy.stats.peakPortfolioValueUsd) *
                        100
                    : null,
              ),
              if (strategy.stats.totalRealizedPnlUsd == 0 &&
                  strategy.stats.totalTrades > 0)
                Text(
                  '${strategy.stats.totalTrades} trade(s) · open positions P&L on detail',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              if (strategy.lastCycleAt != null) ...[
                const SizedBox(height: 8),
                Text(
                  'Last cycle ${timeago.format(strategy.lastCycleAt!)}',
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ],
              const SizedBox(height: 8),
              LinearProgressIndicator(
                value: _cycleIntervalProgress(strategy),
                backgroundColor:
                    Theme.of(context).colorScheme.surfaceContainerHighest,
              ),
              Text(
                _nextCheckLabel(strategy),
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showActions(BuildContext context, WidgetRef ref) {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(
                strategy.isPaused ? Icons.play_arrow : Icons.pause,
              ),
              title: Text(strategy.isPaused ? 'Resume' : 'Pause'),
              onTap: () async {
                Navigator.pop(ctx);
                final fn = ref.read(cloudFunctionsProvider);
                try {
                  if (strategy.isPaused) {
                    await fn.resumeStrategy(strategy.strategyId);
                  } else {
                    await fn.pauseStrategy(strategy.strategyId);
                  }
                } on FirebaseFunctionsException catch (e) {
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                          friendlyCloudFunctionError(e.code, e.message),
                        ),
                      ),
                    );
                  }
                }
              },
            ),
            ListTile(
              leading: const Icon(Icons.copy),
              title: const Text('Clone'),
              onTap: () async {
                Navigator.pop(ctx);
                await ref
                    .read(cloudFunctionsProvider)
                    .cloneStrategy(strategy.strategyId);
              },
            ),
            ListTile(
              leading: const Icon(Icons.archive_outlined),
              title: const Text('Archive'),
              onTap: () async {
                Navigator.pop(ctx);
                await ref
                    .read(cloudFunctionsProvider)
                    .archiveStrategy(strategy.strategyId);
              },
            ),
          ],
        ),
      ),
    );
  }
}
