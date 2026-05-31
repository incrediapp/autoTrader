import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/cloud_functions.dart';
import '../../shared/models/replay_session_model.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/user_provider.dart';

class ReplayScreen extends ConsumerStatefulWidget {
  const ReplayScreen({super.key, required this.strategyId});

  final String strategyId;

  @override
  ConsumerState<ReplayScreen> createState() => _ReplayScreenState();
}

class _ReplayScreenState extends ConsumerState<ReplayScreen> {
  ReplaySessionModel? _session;
  List<ReplayStepModel> _steps = [];
  int _index = 0;
  bool _playing = false;
  int _speed = 1;

  Future<void> _generate() async {
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2024),
      lastDate: DateTime.now(),
    );
    if (range == null) return;

    try {
      final result = await ref.read(cloudFunctionsProvider).generateReplaySession(
            strategyId: widget.strategyId,
            startDate: range.start,
            endDate: range.end,
          );
      final sessionId = result['sessionId']?.toString();
      if (sessionId == null) return;
      _listenSession(sessionId);
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message))),
        );
      }
    }
  }

  void _listenSession(String sessionId) {
    final userId = ref.read(userIdProvider);
    if (userId == null) return;
    FirebaseFirestore.instance
        .doc(
            'users/$userId/strategies/${widget.strategyId}/replaySessions/$sessionId')
        .snapshots()
        .listen((snap) {
      if (!snap.exists) return;
      setState(() => _session = ReplaySessionModel.fromDoc(snap));
      if (_session?.isReady == true) {
        _loadSteps(userId, sessionId);
      }
    });
  }

  Future<void> _loadSteps(String userId, String sessionId) async {
    final snap = await FirebaseFirestore.instance
        .collection(
            'users/$userId/strategies/${widget.strategyId}/replaySessions/$sessionId/steps')
        .orderBy('stepIndex')
        .get();
    setState(() {
      _steps = snap.docs.map(ReplayStepModel.fromDoc).toList();
      _index = 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    final step = _steps.isNotEmpty ? _steps[_index] : null;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Replay Mode'),
        actions: [
          IconButton(icon: const Icon(Icons.add), onPressed: _generate),
        ],
      ),
      body: _session == null
          ? Center(
              child: FilledButton(
                onPressed: _generate,
                child: const Text('Select date range'),
              ),
            )
          : Column(
              children: [
                if (_session!.status == 'generating')
                  LinearProgressIndicator(value: _session!.progress / 100),
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    'Step ${_index + 1}/${_steps.length} · ${_session!.status}',
                  ),
                ),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.skip_previous),
                      onPressed: _index > 0 ? () => setState(() => _index = 0) : null,
                    ),
                    IconButton(
                      icon: Icon(_playing ? Icons.pause : Icons.play_arrow),
                      onPressed: () => setState(() => _playing = !_playing),
                    ),
                    IconButton(
                      icon: const Icon(Icons.skip_next),
                      onPressed: _index < _steps.length - 1
                          ? () => setState(() => _index = _steps.length - 1)
                          : null,
                    ),
                    DropdownButton<int>(
                      value: _speed,
                      items: const [
                        DropdownMenuItem(value: 1, child: Text('1×')),
                        DropdownMenuItem(value: 2, child: Text('2×')),
                        DropdownMenuItem(value: 5, child: Text('5×')),
                        DropdownMenuItem(value: 10, child: Text('10×')),
                      ],
                      onChanged: (v) => setState(() => _speed = v!),
                    ),
                  ],
                ),
                if (step != null)
                  Expanded(
                    child: ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        Text(
                          step.decision.action.toUpperCase(),
                          style: Theme.of(context).textTheme.headlineSmall,
                        ),
                        Text(step.decision.reasoning ?? ''),
                        const Divider(),
                        Text('Portfolio \$${step.portfolioSnapshot.totalValueUsd.toStringAsFixed(2)}'),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }
}
