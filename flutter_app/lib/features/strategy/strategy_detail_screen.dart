import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../services/cloud_functions.dart';
import '../../shared/models/strategy_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/cycles_provider.dart';
import '../../shared/providers/strategies_provider.dart';
import '../../shared/providers/trades_provider.dart';
import '../../shared/widgets/cycle_entry_card.dart';
import '../../shared/widgets/error_state.dart';
import '../../shared/widgets/hold_to_confirm_button.dart';
import '../../shared/widgets/mode_badge.dart';
import '../../shared/widgets/skeleton.dart';
import 'strategy_autopilot_tab.dart';
import 'strategy_portfolio_tab.dart';
import 'strategy_shadow_tab.dart';

class StrategyDetailScreen extends ConsumerStatefulWidget {
  const StrategyDetailScreen({super.key, required this.strategyId});

  final String strategyId;

  @override
  ConsumerState<StrategyDetailScreen> createState() =>
      _StrategyDetailScreenState();
}

class _StrategyDetailScreenState extends ConsumerState<StrategyDetailScreen>
    with SingleTickerProviderStateMixin {
  TabController? _tabs;

  @override
  void dispose() {
    _tabs?.dispose();
    super.dispose();
  }

  void _initTabs(int count) {
    if (_tabs != null && _tabs!.length == count) return;
    _tabs?.dispose();
    _tabs = TabController(length: count, vsync: this);
  }

  @override
  Widget build(BuildContext context) {
    final strategyAsync = ref.watch(strategyProvider(widget.strategyId));
    final shadows = ref.watch(shadowConfigsProvider(widget.strategyId));
    final autopilotReports =
        ref.watch(autopilotReportsProvider(widget.strategyId));
    final pendingReport = ref.watch(pendingAutopilotProvider(widget.strategyId));

    return strategyAsync.when(
      data: (strategy) {
        if (strategy == null) {
          return const Scaffold(
            body: Center(child: Text('Strategy not found')),
          );
        }

        final hasAutopilot =
            (autopilotReports.valueOrNull?.isNotEmpty ?? false);
        final hasShadow = shadows.valueOrNull?.isNotEmpty ?? false;
        final count = 3 + (hasAutopilot ? 1 : 0) + (hasShadow ? 1 : 0);
        _initTabs(count);

        return Scaffold(
          appBar: AppBar(
            title: Row(
              children: [
                Expanded(child: Text(strategy.name)),
                IconButton(
                  icon: const Icon(Icons.sensors),
                  tooltip: 'Live signals',
                  onPressed: () => context.push(
                    '/dashboard/strategy/${widget.strategyId}/live-signals',
                  ),
                ),
              ],
            ),
            bottom: TabBar(
              controller: _tabs,
              isScrollable: true,
              tabs: [
                const Tab(text: 'Portfolio'),
                const Tab(text: 'Reasoning'),
                const Tab(text: 'Trades'),
                if (hasAutopilot)
                  Tab(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('Autopilot'),
                        if (pendingReport != null) ...[
                          const SizedBox(width: 4),
                          Badge(
                            label: Text('${pendingReport.proposals.length}'),
                          ),
                        ],
                      ],
                    ),
                  ),
                if (hasShadow) const Tab(text: 'Shadow'),
              ],
            ),
            actions: [
              PopupMenuButton<String>(
                onSelected: (v) {
                  if (v == 'monte') {
                    context.push(
                      '/dashboard/strategy/${widget.strategyId}/monte-carlo',
                    );
                  } else if (v == 'replay') {
                    context.push(
                      '/dashboard/strategy/${widget.strategyId}/replay',
                    );
                  }
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(
                    value: 'monte',
                    child: Text('Risk simulation'),
                  ),
                  const PopupMenuItem(
                    value: 'replay',
                    child: Text('Replay historical period'),
                  ),
                ],
              ),
            ],
          ),
          body: Column(
            children: [
              _ModeBar(strategy: strategy),
              if (strategy.isLive)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: HoldToConfirmButton(
                    label: 'Emergency Sell — hold to execute',
                    onConfirmed: () => _emergencySell(strategy),
                  ),
                ),
              Expanded(
                child: TabBarView(
                  controller: _tabs,
                  children: [
                    StrategyPortfolioTab(
                      strategyId: widget.strategyId,
                      strategy: strategy,
                    ),
                    _ReasoningTab(strategyId: widget.strategyId),
                    _TradesTab(strategyId: widget.strategyId),
                    if (hasAutopilot)
                      StrategyAutopilotTab(
                        strategyId: widget.strategyId,
                      ),
                    if (hasShadow)
                      StrategyShadowTab(
                        strategyId: widget.strategyId,
                      ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
      loading: () => const Scaffold(body: SkeletonList()),
      error: (e, _) => Scaffold(
        body: ErrorState(
          error: e,
          onRetry: () => ref.invalidate(strategyProvider(widget.strategyId)),
        ),
      ),
    );
  }

  Future<void> _emergencySell(StrategyModel strategy) async {
    try {
      await ref.read(cloudFunctionsProvider).emergencySell(
            strategyId: strategy.strategyId,
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Emergency sell initiated')),
        );
      }
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(friendlyCloudFunctionError(e.code, e.message)),
          ),
        );
      }
    }
  }
}

class _ModeBar extends ConsumerWidget {
  const _ModeBar({required this.strategy});

  final StrategyModel strategy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          InkWell(
            onTap: () => _showLiveSwitch(context, ref),
            child: ModeBadge(mode: strategy.mode),
          ),
          DecisionModeBadge(mode: strategy.decisionMode),
          if (strategy.isPaused)
            Chip(
              label: Text(strategy.status.replaceAll('_', ' ')),
              visualDensity: VisualDensity.compact,
            ),
          TextButton.icon(
            onPressed: () async {
              final fn = ref.read(cloudFunctionsProvider);
              if (strategy.isPaused) {
                await fn.resumeStrategy(strategy.strategyId);
              } else {
                await fn.pauseStrategy(strategy.strategyId);
              }
            },
            icon: Icon(strategy.isPaused ? Icons.play_arrow : Icons.pause),
            label: Text(strategy.isPaused ? 'Resume' : 'Pause'),
          ),
        ],
      ),
    );
  }

  void _showLiveSwitch(BuildContext context, WidgetRef ref) {
    if (strategy.isLive) return;
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Switch to Live'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(strategy.claudeSummary),
            const SizedBox(height: 16),
            const Text(
              'Hold the button below for 2 seconds to confirm. Live trading uses real money.',
            ),
            const SizedBox(height: 16),
            HoldToConfirmButton(
              label: 'Switch to Live',
              color: Theme.of(context).colorScheme.primary,
              onConfirmed: () async {
                Navigator.pop(ctx);
                try {
                  await ref.read(cloudFunctionsProvider).switchStrategyMode(
                        strategyId: strategy.strategyId,
                        mode: 'live',
                      );
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
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
        ],
      ),
    );
  }
}

class _ReasoningTab extends ConsumerWidget {
  const _ReasoningTab({required this.strategyId});

  final String strategyId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cycles = ref.watch(cyclesFeedProvider(strategyId));
    return cycles.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) => CycleEntryCard(
          cycle: list[i],
          onTap: () => context.push(
            '/dashboard/strategy/$strategyId/cycle/${list[i].cycleId}',
          ),
        ),
      ),
      loading: () => const SkeletonList(),
      error: (e, _) => ErrorState(
        error: e,
        onRetry: () => ref.invalidate(cyclesFeedProvider(strategyId)),
      ),
    );
  }
}

class _TradesTab extends ConsumerWidget {
  const _TradesTab({required this.strategyId});

  final String strategyId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final trades = ref.watch(
      tradesFeedProvider(TradeQuery(strategyId: strategyId)),
    );
    return trades.when(
      data: (list) => ListView.builder(
        itemCount: list.length,
        itemBuilder: (_, i) {
          final t = list[i];
          return ListTile(
            leading: Icon(
              t.side == 'buy' ? Icons.arrow_upward : Icons.arrow_downward,
              color: t.side == 'buy' ? Colors.green : Colors.red,
            ),
            title: Text('${t.side.toUpperCase()} ${t.symbol}'),
            subtitle: Text(t.executedAt?.toString() ?? ''),
            trailing: t.realizedPnlUsd != null
                ? Text('\$${t.realizedPnlUsd!.toStringAsFixed(2)}')
                : null,
            onTap: () => context.push(
              '/dashboard/strategy/$strategyId/trade/${t.tradeId}',
            ),
          );
        },
      ),
      loading: () => const SkeletonList(),
      error: (e, _) => ErrorState(error: e),
    );
  }
}
