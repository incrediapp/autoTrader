import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/cloud_functions.dart';
import '../../shared/providers/cloud_functions_provider.dart';
import '../../shared/providers/user_provider.dart';
import '../../shared/widgets/broker_chip.dart';

class BrokerConnectionsScreen extends ConsumerStatefulWidget {
  const BrokerConnectionsScreen({super.key});

  @override
  ConsumerState<BrokerConnectionsScreen> createState() =>
      _BrokerConnectionsScreenState();
}

class _BrokerConnectionsScreenState extends ConsumerState<BrokerConnectionsScreen> {
  final _apiKey = TextEditingController();
  final _apiSecret = TextEditingController();
  String _broker = 'binance';
  bool _testnetEnabled = true;
  bool _loading = false;

  @override
  void dispose() {
    _apiKey.dispose();
    _apiSecret.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() => _loading = true);
    try {
      final result = await ref.read(cloudFunctionsProvider).connectBroker(
            broker: _broker,
            testnetEnabled: _testnetEnabled,
            credentials: _broker == 'ibkr'
                ? null
                : {
                    'apiKey': _apiKey.text.trim(),
                    'apiSecret': _apiSecret.text.trim(),
                  },
          );
      if (mounted) {
        final warning = result['validationWarning'] as String?;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              warning ??
                  'Broker connected${_testnetEnabled ? ' (testnet)' : ''}',
            ),
            duration: Duration(seconds: warning != null ? 8 : 4),
          ),
        );
        Navigator.pop(context);
      }
    } on FirebaseFunctionsException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyCloudFunctionError(e.code, e.message))),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Connection failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = ref.watch(userProvider).valueOrNull;

    return Scaffold(
      appBar: AppBar(title: const Text('Broker connections')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          ListTile(
            title: const Text('Binance'),
            trailing: BrokerChip(
              broker: 'binance',
              connected: user?.brokers.binanceConnected ?? false,
            ),
            onTap: () => setState(() => _broker = 'binance'),
          ),
          ListTile(
            title: const Text('Interactive Brokers'),
            trailing: BrokerChip(
              broker: 'ibkr',
              connected: user?.brokers.ibkrConnected ?? false,
            ),
            onTap: () => setState(() => _broker = 'ibkr'),
          ),
          const Divider(),
          if (_broker == 'ibkr') ...[
            Text(
              'IBKR uses your personal OAuth credentials stored on the server '
              '(.env / Secret Manager). Tap Connect to enable IBKR strategies.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ] else ...[
            SwitchListTile(
              title: const Text('Use Binance testnet'),
              subtitle: const Text('Recommended — create keys at testnet.binance.vision'),
              value: _testnetEnabled,
              onChanged: (v) => setState(() => _testnetEnabled = v),
            ),
            Text(
              'Create keys at testnet.binance.vision (log in with GitHub). '
              'Keep "Use Binance testnet" enabled. Server validates the keys for web.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _apiKey,
              decoration: const InputDecoration(labelText: 'API Key'),
              obscureText: true,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _apiSecret,
              decoration: const InputDecoration(labelText: 'API Secret'),
              obscureText: true,
            ),
          ],
          const SizedBox(height: 16),
          FilledButton(
            onPressed: _loading ? null : _connect,
            child: _loading
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Connect'),
          ),
        ],
      ),
    );
  }
}
