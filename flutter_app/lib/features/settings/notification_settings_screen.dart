import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class NotificationSettingsScreen extends ConsumerStatefulWidget {
  const NotificationSettingsScreen({super.key});

  @override
  ConsumerState<NotificationSettingsScreen> createState() =>
      _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState
    extends ConsumerState<NotificationSettingsScreen> {
  bool _onTrade = true;
  bool _onCycle = false;
  bool _onSignificant = true;
  bool _dailySummary = true;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Notification settings')),
      body: ListView(
        children: [
          SwitchListTile(
            title: const Text('Trade executed'),
            value: _onTrade,
            onChanged: (v) => setState(() => _onTrade = v),
          ),
          SwitchListTile(
            title: const Text('Every cycle check'),
            subtitle: const Text('Verbose — not recommended'),
            value: _onCycle,
            onChanged: (v) => setState(() => _onCycle = v),
          ),
          SwitchListTile(
            title: const Text('Important events'),
            value: _onSignificant,
            onChanged: (v) => setState(() => _onSignificant = v),
          ),
          SwitchListTile(
            title: const Text('Daily summary'),
            value: _dailySummary,
            onChanged: (v) => setState(() => _dailySummary = v),
          ),
        ],
      ),
    );
  }
}
