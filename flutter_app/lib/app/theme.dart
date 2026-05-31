import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

ThemeData buildTheme(Brightness brightness) {
  final base = brightness == Brightness.dark
      ? ThemeData.dark(useMaterial3: true)
      : ThemeData.light(useMaterial3: true);

  return base.copyWith(
    colorScheme: ColorScheme.fromSeed(
      seedColor: const Color(0xFF1A56DB),
      brightness: brightness,
    ),
    cardTheme: const CardThemeData(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
    ),
    textTheme: GoogleFonts.interTextTheme(base.textTheme),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    navigationBarTheme: const NavigationBarThemeData(
      elevation: 0,
    ),
  );
}
