import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shared/widgets/empty_state.dart';

class NotificationHistoryScreen extends ConsumerWidget {
  const NotificationHistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Notifications')),
      body: const EmptyState(
        title: 'Notification history',
        subtitle:
            'Push notifications appear here. Trade, cycle, and autopilot events are delivered via FCM.',
        icon: Icons.notifications_none,
      ),
    );
  }
}
