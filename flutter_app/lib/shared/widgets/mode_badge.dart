import 'package:flutter/material.dart';

import '../../app/app_colors.dart';

class ModeBadge extends StatelessWidget {
  const ModeBadge({super.key, required this.mode});

  final String mode;

  @override
  Widget build(BuildContext context) {
    final isLive = mode == 'live';
    return Chip(
      label: Text(mode.toUpperCase()),
      labelStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
      backgroundColor: (isLive ? AppColors.live : AppColors.paper)
          .withValues(alpha: 0.2),
      side: BorderSide(color: isLive ? AppColors.live : AppColors.paper),
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
    );
  }
}

class DecisionModeBadge extends StatelessWidget {
  const DecisionModeBadge({super.key, required this.mode});

  final String mode;

  @override
  Widget build(BuildContext context) {
    final isAuto = mode == 'autonomous_reasoner';
    final label = isAuto ? 'AUTO' : 'RULE';
    return Chip(
      label: Text(label),
      labelStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
      visualDensity: VisualDensity.compact,
      padding: EdgeInsets.zero,
    );
  }
}
