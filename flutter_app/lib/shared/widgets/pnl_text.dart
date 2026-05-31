import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../app/app_colors.dart';

class PnlText extends StatelessWidget {
  const PnlText({
    super.key,
    required this.pnl,
    this.showPercent = false,
    this.pct,
    this.style,
  });

  final double pnl;
  final bool showPercent;
  final double? pct;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final color = pnl >= 0 ? AppColors.pnlPositive : AppColors.pnlNegative;
    final sign = pnl >= 0 ? '+' : '';
    final usd = NumberFormat.currency(symbol: '\$', decimalDigits: 2).format(pnl);
    var text = '$sign$usd';
    if (showPercent && pct != null) {
      text += ' (${pct! >= 0 ? '+' : ''}${pct!.toStringAsFixed(1)}%)';
    }
    return Text(
      text,
      style: (style ?? Theme.of(context).textTheme.titleMedium)
          ?.copyWith(color: color, fontWeight: FontWeight.w600),
    );
  }
}
