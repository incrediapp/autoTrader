import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/cloud_functions.dart';
import '../../shared/models/autopilot_report_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/strategies_provider.dart';
import '../../shared/widgets/confidence_bar.dart';

class StrategyAutopilotTab extends ConsumerStatefulWidget {
  const StrategyAutopilotTab({super.key, required this.strategyId});

  final String strategyId;

  @override
  ConsumerState<StrategyAutopilotTab> createState() =>
      _StrategyAutopilotTabState();
}

class _StrategyAutopilotTabState extends ConsumerState<StrategyAutopilotTab> {
  final _accepted = <String>{};

  @override
  Widget build(BuildContext context) {
    final reports = ref.watch(autopilotReportsProvider(widget.strategyId));

    return reports.when(
      data: (list) {
        final report = list.where((r) => r.isPending).firstOrNull ??
            list.firstOrNull;
        if (report == null) {
          return Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Text('No autopilot reports yet'),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () => ref
                      .read(cloudFunctionsProvider)
                      .triggerAutopilotAnalysis(widget.strategyId),
                  child: const Text('Run analysis now'),
                ),
              ],
            ),
          );
        }
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              'Weekly Autopilot Review',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            Text('Based on ${report.tradesAnalysed} trades'),
            const SizedBox(height: 16),
            ...report.proposals.map((p) => _ProposalCard(
                  proposal: p,
                  accepted: _accepted.contains(p.proposalId),
                  onToggle: (v) => setState(() {
                    if (v) {
                      _accepted.add(p.proposalId);
                    } else {
                      _accepted.remove(p.proposalId);
                    }
                  }),
                )),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _accepted.isEmpty
                  ? null
                  : () => _apply(report.reportId),
              child: const Text('Apply accepted changes'),
            ),
          ],
        );
      },
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text('$e')),
    );
  }

  Future<void> _apply(String reportId) async {
    try {
      await ref.read(cloudFunctionsProvider).applyAutopilotProposals(
            strategyId: widget.strategyId,
            reportId: reportId,
            acceptedProposalIds: _accepted.toList(),
          );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Proposals applied')),
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

class _ProposalCard extends StatelessWidget {
  const _ProposalCard({
    required this.proposal,
    required this.accepted,
    required this.onToggle,
  });

  final AutopilotProposal proposal;
  final bool accepted;
  final ValueChanged<bool> onToggle;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(proposal.description, style: Theme.of(context).textTheme.titleSmall),
            if (proposal.before != null) ...[
              const SizedBox(height: 8),
              Text('BEFORE: ${proposal.before}', style: const TextStyle(fontFamily: 'monospace')),
            ],
            if (proposal.after != null) ...[
              Text('AFTER: ${proposal.after}', style: const TextStyle(fontFamily: 'monospace')),
            ],
            const SizedBox(height: 8),
            Text(proposal.dataEvidence),
            ConfidenceBar(confidence: proposal.confidence),
            SwitchListTile(
              value: accepted,
              onChanged: onToggle,
              title: const Text('Accept proposal'),
            ),
          ],
        ),
      ),
    );
  }
}
