import 'package:flutter/material.dart';

class BootstrapScreen extends StatelessWidget {
  const BootstrapScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
