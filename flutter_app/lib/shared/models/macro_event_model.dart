import 'package:cloud_firestore/cloud_firestore.dart';

import 'timestamp_utils.dart';

class MacroEventModel {
  final String eventId;
  final String eventName;
  final String shortName;
  final String country;
  final DateTime? eventDate;
  final String? eventTime;
  final String impact;
  final String? currency;
  final String? actual;
  final String? forecast;
  final String? previous;

  const MacroEventModel({
    required this.eventId,
    required this.eventName,
    this.shortName = '',
    this.country = '',
    this.eventDate,
    this.eventTime,
    this.impact = 'low',
    this.currency,
    this.actual,
    this.forecast,
    this.previous,
  });

  factory MacroEventModel.fromDoc(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data() ?? {};
    return MacroEventModel.fromJson(data, id: doc.id);
  }

  factory MacroEventModel.fromJson(Map<String, dynamic> json, {String? id}) {
    return MacroEventModel(
      eventId: id ?? json['eventId']?.toString() ?? '',
      eventName: json['eventName']?.toString() ?? '',
      shortName: json['shortName']?.toString() ?? '',
      country: json['country']?.toString() ?? '',
      eventDate: parseTimestamp(json['eventDate']),
      eventTime: json['eventTime']?.toString(),
      impact: json['impact']?.toString() ?? 'low',
      currency: json['currency']?.toString(),
      actual: json['actual']?.toString(),
      forecast: json['forecast']?.toString(),
      previous: json['previous']?.toString(),
    );
  }
}
