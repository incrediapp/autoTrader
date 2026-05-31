import 'package:flutter/material.dart';

import '../../app/app_colors.dart';

class ConfidenceBar extends StatelessWidget {
  const ConfidenceBar({super.key, required this.confidence});

  final double confidence;

  Color get _color {
    if (confidence < 0.4) return AppColors.critical;
    if (confidence < 0.6) return AppColors.warning;
    return AppColors.pnlPositive;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Confidence', style: Theme.of(context).textTheme.labelSmall),
            Text(
              confidence.toStringAsFixed(2),
              style: Theme.of(context).textTheme.labelSmall,
            ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: confidence.clamp(0, 1),
            minHeight: 8,
            color: _color,
            backgroundColor: _color.withValues(alpha: 0.2),
          ),
        ),
      ],
    );
  }
}
