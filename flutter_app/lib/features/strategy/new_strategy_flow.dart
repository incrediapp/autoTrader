import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../services/cloud_functions.dart';
import '../../shared/providers/cloud_functions_provider.dart';

class NewStrategyFlow extends ConsumerStatefulWidget {
  const NewStrategyFlow({super.key, this.fromOnboarding = false});

  final bool fromOnboarding;

  @override
  ConsumerState<NewStrategyFlow> createState() => _NewStrategyFlowState();
}

class _NewStrategyFlowState extends ConsumerState<NewStrategyFlow> {
  final _pageController = PageController();
  int _step = 0;
  final _name = TextEditingController();
  String _decisionMode = 'rule_interpreter';
  final _chatController = TextEditingController();
  final _messages = <Map<String, String>>[];
  bool _chatLoading = false;
  Map<String, dynamic>? _setupSummary;
  double _maxLoss = 5;
  double _maxDrawdown = 20;
  double _maxPosition = 25;
  int _maxPositions = 3;
  final _assets = <String>['ETHUSDT'];
  String _broker = 'binance';
  int _interval = 15;
  bool _loading = false;

  @override
  void dispose() {
    _pageController.dispose();
    _name.dispose();
    _chatController.dispose();
    super.dispose();
  }

  Future<void> _sendChat() async {
    if (_chatLoading || _chatController.text.trim().isEmpty) return;
    final msg = _chatController.text.trim();
    setState(() {
      _messages.add({'role': 'user', 'text': msg});
      _chatLoading = true;
    });
    _chatController.clear();
    try {
      final description = _messages
          .firstWhere((m) => m['role'] == 'user', orElse: () => {'text': msg})['text']!;
      final firstUserIdx = _messages.indexWhere((m) => m['role'] == 'user');
      final clarificationHistory = <Map<String, String>>[];
      for (var i = firstUserIdx + 1; i < _messages.length; i++) {
        final m = _messages[i];
        clarificationHistory.add({
          'role': m['role']!,
          'content': m['text']!,
        });
      }

      final result = await ref.read(cloudFunctionsProvider).strategySetup(
            strategyName: _name.text.trim(),
            description: description,
            decisionMode: _decisionMode,
            clarificationHistory: clarificationHistory,
          );
      final reply = _formatSetupReply(result);
      setState(() {
        _messages.add({'role': 'assistant', 'text': reply});
        if (result['needsClarification'] == false) {
          _setupSummary = result;
          final suggested = result['suggestedAssets'];
          if (suggested is List && suggested.isNotEmpty) {
            _assets
              ..clear()
              ..addAll(suggested.map((a) => a.toString()));
          }
          final broker = result['suggestedBroker']?.toString();
          if (broker == 'binance' || broker == 'ibkr') {
            _broker = broker!;
          }
          final interval = result['suggestedCheckIntervalMinutes'];
          if (interval is num) {
            _interval = interval.toInt();
          }
        }
      });
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        setState(() {
          _messages.removeLast();
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message, e.details))),
        );
      }
    } finally {
      setState(() => _chatLoading = false);
    }
  }

  String _formatSetupReply(Map<String, dynamic> result) {
    if (result['needsClarification'] == true) {
      final questions = result['clarifyingQuestions'];
      if (questions is List && questions.isNotEmpty) {
        return questions.map((q) => '• $q').join('\n');
      }
    }
    return result['summary']?.toString() ?? 'Strategy understood.';
  }

  String get _strategyDescription {
    final first = _messages.firstWhere(
      (m) => m['role'] == 'user',
      orElse: () => {'text': ''},
    );
    return first['text']?.trim() ?? '';
  }

  Future<void> _create() async {
    final summary = _setupSummary?['summary']?.toString();
    if (summary == null || summary.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Describe your strategy in the chat step before creating.'),
        ),
      );
      return;
    }

    setState(() => _loading = true);
    try {
      final result = await ref.read(cloudFunctionsProvider).createStrategy({
        'name': _name.text.trim(),
        'description': _strategyDescription.isNotEmpty
            ? _strategyDescription
            : summary,
        'decisionMode': _decisionMode,
        'claudeSummary': summary,
        'rules': _setupSummary?['rules'] ?? [],
        'risk': {
          'maxLossPerTradePct': _maxLoss,
          'maxDrawdownPct': _maxDrawdown,
          'maxPositionSizePct': _maxPosition,
          'maxOpenPositions': _maxPositions,
        },
        'assets': {'broker': _broker, 'watchlist': _assets},
        'schedule': {'checkIntervalMinutes': _interval},
      });
      final id = result['strategyId']?.toString();
      if (mounted && id != null) {
        if (widget.fromOnboarding) {
          Navigator.of(context).pop(true);
        } else {
          context.go('/dashboard/strategy/$id');
        }
      }
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message, e.details))),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _next() {
    _pageController.nextPage(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeInOut,
    );
    setState(() => _step++);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Step ${_step + 1} of 6'),
        leading: IconButton(
          icon: const Icon(Icons.close),
          onPressed: () => context.pop(),
        ),
      ),
      body: Stack(
        children: [
          PageView(
            controller: _pageController,
            physics: const NeverScrollableScrollPhysics(),
            children: [
              _nameStep(),
              _chatStep(),
              _riskStep(),
              _assetsStep(),
              _notificationsStep(),
              _reviewStep(),
            ],
          ),
          if (_loading)
            const ColoredBox(
              color: Color(0x88000000),
              child: Center(child: CircularProgressIndicator()),
            ),
        ],
      ),
    );
  }

  Widget _nameStep() {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'Strategy name'),
            maxLength: 50,
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 24),
          const Text('Decision mode'),
          RadioListTile(
            value: 'rule_interpreter',
            groupValue: _decisionMode,
            onChanged: (v) => setState(() => _decisionMode = v!),
            title: const Text('Rule Interpreter'),
            subtitle: const Text('Predictable, cheaper'),
          ),
          RadioListTile(
            value: 'autonomous_reasoner',
            groupValue: _decisionMode,
            onChanged: (v) => setState(() => _decisionMode = v!),
            title: const Text('Autonomous'),
            subtitle: const Text('Flexible, costs more'),
          ),
          const Spacer(),
          FilledButton(onPressed: _name.text.isNotEmpty ? _next : null, child: const Text('Next')),
        ],
      ),
    );
  }

  Widget _chatStep() {
    return Column(
      children: [
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(16),
            itemCount: _messages.length + (_chatLoading ? 1 : 0),
            itemBuilder: (_, i) {
              if (i == _messages.length) {
                return const ListTile(
                  leading: CircularProgressIndicator(),
                  title: Text('Claude is thinking…'),
                );
              }
              final m = _messages[i];
              final isUser = m['role'] == 'user';
              return Align(
                alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
                child: Container(
                  margin: const EdgeInsets.symmetric(vertical: 4),
                  padding: const EdgeInsets.all(12),
                  constraints: BoxConstraints(
                    maxWidth: MediaQuery.sizeOf(context).width * 0.8,
                  ),
                  decoration: BoxDecoration(
                    color: isUser
                        ? Theme.of(context).colorScheme.primaryContainer
                        : Theme.of(context).colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(m['text'] ?? ''),
                ),
              );
            },
          ),
        ),
        if (_setupSummary != null)
          Card(
            margin: const EdgeInsets.all(16),
            child: ListTile(
              title: const Text('Claude understood your strategy'),
              subtitle: Text(_setupSummary!['summary']?.toString() ?? ''),
              trailing: FilledButton(onPressed: _next, child: const Text('Looks good')),
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _chatController,
                  decoration: const InputDecoration(hintText: 'Describe your strategy…'),
                  onSubmitted: _chatLoading ? null : (_) => _sendChat(),
                ),
              ),
              IconButton(
                onPressed: _chatLoading ? null : _sendChat,
                icon: const Icon(Icons.send),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _riskStep() {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text('Max loss per trade: ${_maxLoss.toStringAsFixed(0)}%'),
        Slider(value: _maxLoss, min: 1, max: 50, onChanged: (v) => setState(() => _maxLoss = v)),
        Text('Max drawdown: ${_maxDrawdown.toStringAsFixed(0)}%'),
        Slider(value: _maxDrawdown, min: 5, max: 50, onChanged: (v) => setState(() => _maxDrawdown = v)),
        Text('Max position size: ${_maxPosition.toStringAsFixed(0)}%'),
        Slider(value: _maxPosition, min: 5, max: 100, onChanged: (v) => setState(() => _maxPosition = v)),
        FilledButton(onPressed: _next, child: const Text('Next')),
      ],
    );
  }

  Widget _assetsStep() {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Wrap(
          spacing: 8,
          children: _assets
              .map((a) => Chip(label: Text(a), onDeleted: () => setState(() => _assets.remove(a))))
              .toList(),
        ),
        DropdownButtonFormField(
          value: _broker,
          decoration: const InputDecoration(labelText: 'Broker'),
          items: const [
            DropdownMenuItem(value: 'binance', child: Text('Binance')),
            DropdownMenuItem(value: 'ibkr', child: Text('IBKR')),
          ],
          onChanged: (v) => setState(() => _broker = v!),
        ),
        DropdownButtonFormField(
          value: _interval,
          decoration: const InputDecoration(labelText: 'Check every'),
          items: const [
            DropdownMenuItem(value: 5, child: Text('5 min')),
            DropdownMenuItem(value: 15, child: Text('15 min')),
            DropdownMenuItem(value: 30, child: Text('30 min')),
            DropdownMenuItem(value: 60, child: Text('60 min')),
          ],
          onChanged: (v) => setState(() => _interval = v!),
        ),
        FilledButton(onPressed: _next, child: const Text('Next')),
      ],
    );
  }

  Widget _notificationsStep() {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        SwitchListTile(title: const Text('Trade executed'), value: true, onChanged: (_) {}),
        SwitchListTile(title: const Text('Important events'), value: true, onChanged: (_) {}),
        SwitchListTile(title: const Text('Daily summary'), value: true, onChanged: (_) {}),
        FilledButton(onPressed: _next, child: const Text('Next')),
      ],
    );
  }

  Widget _reviewStep() {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Review', style: Theme.of(context).textTheme.titleLarge),
          Text('Name: ${_name.text}'),
          Text('Mode: $_decisionMode'),
          Text('Assets: ${_assets.join(', ')}'),
          const Chip(label: Text('ℹ️ Live switch available after 24h paper')),
          const Spacer(),
          FilledButton(
            onPressed: _create,
            child: const Text('Start in Paper Mode'),
          ),
        ],
      ),
    );
  }
}
