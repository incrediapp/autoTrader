import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/analytics_data.dart';
import 'cloud_functions_provider.dart';

final analyticsProvider =
    FutureProvider.family<AnalyticsData, AnalyticsQuery>((ref, query) async {
  final fn = ref.watch(cloudFunctionsProvider);
  final result = await fn.getAnalytics(query.toJson());
  return AnalyticsData.fromJson(result);
});

final monteCarloResultsProvider =
    StreamProvider.family<List<Map<String, dynamic>>, String>(
        (ref, strategyId) {
  // Latest result fetched via one-shot after run; stream optional
  return Stream.value([]);
});
