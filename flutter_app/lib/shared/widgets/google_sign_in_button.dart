import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Official multicolor Google "G" paths from Google's Sign in with Google asset bundle.
class _GoogleLogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.width / 20;
    canvas.scale(scale);

    canvas.drawPath(_bluePath(), Paint()..color = const Color(0xFF4285F4));
    canvas.drawPath(_greenPath(), Paint()..color = const Color(0xFF34A853));
    canvas.drawPath(_yellowPath(), Paint()..color = const Color(0xFFFBBC04));
    canvas.drawPath(_redPath(), Paint()..color = const Color(0xFFE94235));
  }

  Path _bluePath() {
    return Path()
      ..moveTo(19.6, 10.2273)
      ..cubicTo(19.6, 9.5182, 19.5364, 8.8364, 19.4182, 8.1818)
      ..lineTo(10, 8.1818)
      ..lineTo(10, 12.05)
      ..lineTo(15.3818, 12.05)
      ..cubicTo(15.15, 13.3, 14.4455, 14.3591, 13.3864, 15.0682)
      ..lineTo(13.3864, 17.5773)
      ..lineTo(16.6182, 17.5773)
      ..cubicTo(18.5091, 15.8364, 19.6, 13.2727, 19.6, 10.2273)
      ..close();
  }

  Path _greenPath() {
    return Path()
      ..moveTo(10, 20)
      ..cubicTo(12.7, 20, 14.9636, 19.1045, 16.6181, 17.5773)
      ..lineTo(13.3863, 15.0682)
      ..cubicTo(12.4909, 15.6682, 11.3454, 16.0227, 10, 16.0227)
      ..cubicTo(7.39545, 16.0227, 5.19091, 14.2636, 4.40455, 11.9)
      ..lineTo(1.06364, 11.9)
      ..lineTo(1.06364, 14.4909)
      ..cubicTo(2.70909, 17.7591, 6.09091, 20, 10, 20)
      ..close();
  }

  Path _yellowPath() {
    return Path()
      ..moveTo(4.40455, 11.9)
      ..cubicTo(4.20455, 11.3, 4.09091, 10.6591, 4.09091, 10)
      ..cubicTo(4.09091, 9.34091, 4.20455, 8.7, 4.40455, 8.1)
      ..lineTo(4.40455, 5.50909)
      ..lineTo(1.06364, 5.50909)
      ..cubicTo(0.386364, 6.85909, 0, 8.38636, 0, 10)
      ..cubicTo(0, 11.6136, 0.386364, 13.1409, 1.06364, 14.4909)
      ..lineTo(4.40455, 11.9)
      ..close();
  }

  Path _redPath() {
    return Path()
      ..moveTo(10, 3.97727)
      ..cubicTo(11.4681, 3.97727, 12.7863, 4.48182, 13.8227, 5.47273)
      ..lineTo(16.6909, 2.60455)
      ..cubicTo(14.9591, 0.990909, 12.6954, 0, 10, 0)
      ..cubicTo(6.09091, 0, 2.70909, 2.24091, 1.06364, 5.50909)
      ..lineTo(4.40455, 8.1)
      ..cubicTo(5.19091, 5.73636, 7.39545, 3.97727, 10, 3.97727)
      ..close();
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Sign in with Google button styled per Google Identity branding guidelines.
class GoogleSignInButton extends StatelessWidget {
  const GoogleSignInButton({
    super.key,
    required this.text,
    required this.onPressed,
    this.height = 44,
  });

  final String text;
  final VoidCallback? onPressed;
  final double height;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    final backgroundColor =
        isDark ? const Color(0xFF131314) : const Color(0xFFFFFFFF);
    final borderColor =
        isDark ? const Color(0xFF8E918F) : const Color(0xFF747775);
    final textColor =
        isDark ? const Color(0xFFE3E3E3) : const Color(0xFF1F1F1F);

    return Semantics(
      button: true,
      label: text,
      enabled: onPressed != null,
      child: SizedBox(
        height: height,
        width: double.infinity,
        child: Material(
          color: backgroundColor,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(height / 2),
            side: BorderSide(color: borderColor),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: CustomPaint(painter: _GoogleLogoPainter()),
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Text(
                      text,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: GoogleFonts.roboto(
                        fontWeight: FontWeight.w500,
                        fontSize: 14,
                        height: 20 / 14,
                        color: onPressed == null
                            ? textColor.withValues(alpha: 0.38)
                            : textColor,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
