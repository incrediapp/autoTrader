import 'package:flutter/material.dart';

import '../../app/app_colors.dart';

class BrokerChip extends StatelessWidget {
  const BrokerChip({
    super.key,
    required this.broker,
    required this.connected,
  });

  final String broker;
  final bool connected;

  @override
  Widget build(BuildContext context) {
    final label = broker == 'ibkr' ? 'IBKR' : 'Binance';
    return Chip(
      avatar: Icon(
        Icons.circle,
        size: 10,
        color: connected ? AppColors.live : AppColors.critical,
      ),
      label: Text(label),
      visualDensity: VisualDensity.compact,
    );
  }
}
