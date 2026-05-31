import 'package:cloud_firestore/cloud_firestore.dart';

DateTime? parseTimestamp(dynamic value) {
  if (value == null) return null;
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) return DateTime.tryParse(value);
  if (value is int) return DateTime.fromMillisecondsSinceEpoch(value);
  return null;
}

double parseDouble(dynamic value, [double fallback = 0]) {
  if (value == null) return fallback;
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value) ?? fallback;
  return fallback;
}

int parseInt(dynamic value, [int fallback = 0]) {
  if (value == null) return fallback;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? fallback;
  return fallback;
}

bool parseBool(dynamic value, [bool fallback = false]) {
  if (value == null) return fallback;
  if (value is bool) return value;
  return fallback;
}

Map<String, dynamic> asMap(dynamic value) =>
    value is Map ? Map<String, dynamic>.from(value) : {};

List<T> asList<T>(dynamic value, T Function(dynamic) mapFn) {
  if (value is! List) return [];
  return value.map(mapFn).toList();
}
