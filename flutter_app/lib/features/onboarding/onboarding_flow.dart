import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../services/cloud_functions.dart';
import '../../shared/providers/auth_provider.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/user_provider.dart';
import '../strategy/new_strategy_flow.dart';
import '../settings/broker_connections_screen.dart';

class OnboardingFlow extends ConsumerStatefulWidget {
  const OnboardingFlow({super.key});

  @override
  ConsumerState<OnboardingFlow> createState() => _OnboardingFlowState();
}

class _OnboardingFlowState extends ConsumerState<OnboardingFlow> {
  final _pageController = PageController();
  int _step = 0;
  bool _finishing = false;

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  Future<void> _finish() async {
    if (_finishing) return;
    setState(() => _finishing = true);
    try {
      await ref.read(cloudFunctionsProvider).completeOnboarding();

      final uid = ref.read(authStateProvider).valueOrNull?.uid;
      if (uid != null) {
        for (var attempt = 0; attempt < 15; attempt++) {
          final snap = await FirebaseFirestore.instance.doc('users/$uid').get();
          final completedAt = snap.data()?['onboarding']?['completedAt'];
          if (completedAt != null) break;
          await Future<void>.delayed(const Duration(milliseconds: 200));
        }
      }

      if (mounted) context.go('/dashboard');
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(friendlyCloudFunctionError(e.code, e.message)),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not complete onboarding: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _finishing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(userProvider).valueOrNull;
    final hasBroker = user?.brokers.hasAnyBroker ?? false;

    return Scaffold(
      appBar: AppBar(
        title: Text('Step ${_step + 1} of 4'),
        automaticallyImplyLeading: false,
      ),
      body: PageView(
        controller: _pageController,
        physics: const NeverScrollableScrollPhysics(),
        onPageChanged: (i) => setState(() => _step = i),
        children: [
          _welcomeStep(),
          _brokerStep(hasBroker),
          _strategyStep(),
          _paperStep(),
        ],
      ),
    );
  }

  Widget _welcomeStep() {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Spacer(),
          Text(
            'Welcome to AI Auto Trader',
            style: Theme.of(context).textTheme.headlineMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Text(
            'Describe strategies in plain English. Claude executes them against your broker accounts with full transparency.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const Spacer(),
          FilledButton(
            onPressed: () => _pageController.nextPage(
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeInOut,
            ),
            child: const Text("Let's get started"),
          ),
        ],
      ),
    );
  }

  Widget _brokerStep(bool hasBroker) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Connect a Broker',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          Text(hasBroker ? 'Connected ✓' : '1 of 1 required'),
          const SizedBox(height: 24),
          Card(
            child: ListTile(
              leading: const Icon(Icons.currency_bitcoin),
              title: const Text('Binance'),
              subtitle: Text(hasBroker ? 'Ready' : 'Tap to connect'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const BrokerConnectionsScreen(),
                ),
              ),
            ),
          ),
          Card(
            child: ListTile(
              leading: const Icon(Icons.show_chart),
              title: const Text('Interactive Brokers'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const BrokerConnectionsScreen(),
                ),
              ),
            ),
          ),
          const Spacer(),
          FilledButton(
            onPressed: hasBroker
                ? () => _pageController.nextPage(
                      duration: const Duration(milliseconds: 300),
                      curve: Curves.easeInOut,
                    )
                : null,
            child: const Text('Continue'),
          ),
        ],
      ),
    );
  }

  Widget _strategyStep() {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Create Your First Strategy',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          const Text(
            'Strategies are independent trading plans with their own assets, risk limits, and decision mode.',
          ),
          const Spacer(),
          FilledButton(
            onPressed: () async {
              final created = await Navigator.of(context).push<bool>(
                MaterialPageRoute<bool>(
                  builder: (_) => const NewStrategyFlow(fromOnboarding: true),
                ),
              );
              if (created == true && mounted) {
                _pageController.nextPage(
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeInOut,
                );
              }
            },
            child: const Text('Create Strategy'),
          ),
          TextButton(
            onPressed: () => _pageController.nextPage(
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeInOut,
            ),
            child: const Text('Skip for now'),
          ),
        ],
      ),
    );
  }

  Widget _paperStep() {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Paper Mode',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 16),
          const Text(
            'All strategies start in Paper mode. You need 24 hours of paper history before going live.',
          ),
          const Spacer(),
          FilledButton(
            onPressed: _finishing ? null : _finish,
            child: _finishing
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Got it'),
          ),
        ],
      ),
    );
  }
}
