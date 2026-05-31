import 'dart:async';

import 'package:flutter/material.dart';

class HoldToConfirmButton extends StatefulWidget {
  const HoldToConfirmButton({
    super.key,
    required this.label,
    required this.onConfirmed,
    this.color,
    this.holdDuration = const Duration(seconds: 2),
  });

  final String label;
  final VoidCallback onConfirmed;
  final Color? color;
  final Duration holdDuration;

  @override
  State<HoldToConfirmButton> createState() => _HoldToConfirmButtonState();
}

class _HoldToConfirmButtonState extends State<HoldToConfirmButton> {
  Timer? _timer;
  double _progress = 0;
  bool _holding = false;

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startHold() {
    setState(() {
      _holding = true;
      _progress = 0;
    });
    var elapsed = 0;
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(milliseconds: 50), (t) {
      elapsed += 50;
      setState(() => _progress = elapsed / widget.holdDuration.inMilliseconds);
      if (elapsed >= widget.holdDuration.inMilliseconds) {
        t.cancel();
        setState(() {
          _holding = false;
          _progress = 0;
        });
        widget.onConfirmed();
      }
    });
  }

  void _cancelHold() {
    _timer?.cancel();
    setState(() {
      _holding = false;
      _progress = 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? Theme.of(context).colorScheme.error;
    return GestureDetector(
      onTapDown: (_) => _startHold(),
      onTapUp: (_) => _cancelHold(),
      onTapCancel: _cancelHold,
      child: Stack(
        alignment: Alignment.center,
        children: [
          SizedBox(
            height: 52,
            width: double.infinity,
            child: _holding
                ? CircularProgressIndicator(
                    value: _progress.clamp(0, 1),
                    color: color,
                    backgroundColor: color.withValues(alpha: 0.2),
                  )
                : null,
          ),
          Container(
            height: 52,
            width: double.infinity,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: color.withValues(alpha: _holding ? 0.15 : 1),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: color),
            ),
            child: Text(
              _holding ? 'Hold…' : widget.label,
              style: TextStyle(
                color: _holding ? color : Colors.white,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
