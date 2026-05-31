import 'package:flutter/material.dart';

import '../../app/app_colors.dart';

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.status, this.size = 10});

  final String status;
  final double size;

  Color get _color => switch (status) {
        'active' => AppColors.live,
        'paused' => AppColors.warning,
        'auto_paused' => AppColors.critical,
        'archived' => AppColors.paper,
        _ => AppColors.paper,
      };

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: _color, shape: BoxShape.circle),
    );
  }
}
