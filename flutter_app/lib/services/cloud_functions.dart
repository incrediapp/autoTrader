import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_core/firebase_core.dart';

class CloudFunctionsService {
  CloudFunctionsService({FirebaseFunctions? functions})
      : _functions = functions ??
            FirebaseFunctions.instanceFor(
              app: Firebase.app(),
              region: 'us-central1',
            );

  final FirebaseFunctions _functions;

  Future<Map<String, dynamic>> _call(
    String name,
    Map<String, dynamic> data,
  ) async {
    final result = await _functions.httpsCallable(name).call(data);
    final raw = result.data;
    if (raw is Map) return Map<String, dynamic>.from(raw);
    return {'data': raw};
  }

  Future<Map<String, dynamic>> createUserProfile({
    required String displayName,
    required String email,
    String? photoUrl,
  }) =>
      _call('createUserProfile', {
        'displayName': displayName,
        'email': email,
        if (photoUrl != null) 'photoUrl': photoUrl,
      });

  Future<Map<String, dynamic>> strategySetup({
    required String strategyName,
    required String description,
    required String decisionMode,
    List<Map<String, String>>? clarificationHistory,
  }) =>
      _call('strategySetup', {
        'strategyName': strategyName,
        'description': description,
        'decisionMode': decisionMode,
        if (clarificationHistory != null && clarificationHistory.isNotEmpty)
          'clarificationHistory': clarificationHistory
              .map((m) => {'role': m['role'], 'content': m['content']})
              .toList(),
      });

  Future<Map<String, dynamic>> createStrategy(Map<String, dynamic> config) =>
      _call('createStrategy', config);

  Future<Map<String, dynamic>> migrateGuestStrategies({
    required String sourceUserId,
    bool withHistory = true,
    List<String>? strategyIds,
  }) =>
      _call('migrateGuestStrategies', {
        'sourceUserId': sourceUserId,
        'withHistory': withHistory,
        if (strategyIds != null && strategyIds.isNotEmpty)
          'strategyIds': strategyIds,
      });

  Future<Map<String, dynamic>> manualCycleTrigger(String strategyId) =>
      _call('manualCycleTrigger', {'strategyId': strategyId});

  Future<void> refreshPortfolio(String strategyId) => _call(
        'refreshPortfolio',
        {'strategyId': strategyId},
      );

  Future<void> switchStrategyMode({
    required String strategyId,
    required String mode,
  }) =>
      _call('switchStrategyMode', {
        'strategyId': strategyId,
        'mode': mode,
      });

  Future<void> switchDecisionMode({
    required String strategyId,
    required String decisionMode,
  }) =>
      _call('switchDecisionMode', {
        'strategyId': strategyId,
        'decisionMode': decisionMode,
      });

  Future<Map<String, dynamic>> emergencySell({
    required String strategyId,
    bool allStrategies = false,
  }) =>
      _call('emergencySell', {
        'strategyId': strategyId,
        'allStrategies': allStrategies,
      });

  Future<Map<String, dynamic>> pauseStrategy(String strategyId) =>
      _call('pauseStrategy', {'strategyId': strategyId});

  Future<Map<String, dynamic>> resumeStrategy(String strategyId) =>
      _call('resumeStrategy', {'strategyId': strategyId});

  Future<Map<String, dynamic>> archiveStrategy(String strategyId) =>
      _call('archiveStrategy', {'strategyId': strategyId});

  Future<Map<String, dynamic>> cloneStrategy(String strategyId) =>
      _call('cloneStrategy', {'strategyId': strategyId});

  Future<Map<String, dynamic>> getAnalytics(Map<String, dynamic> query) =>
      _call('getAnalytics', query);

  Future<Map<String, dynamic>> refreshMacroCalendarNow() =>
      _call('refreshMacroCalendarNow', {});

  Future<Map<String, dynamic>> syncStrategyStats({String? strategyId}) =>
      _call('syncStrategyStats', {
        if (strategyId != null) 'strategyId': strategyId,
      });

  Future<void> updateFcmToken(String token) =>
      _call('updateFcmToken', {'token': token});

  Future<Map<String, dynamic>> connectBroker({
    required String broker,
    Map<String, dynamic>? credentials,
    bool testnetEnabled = true,
  }) =>
      _call('connectBroker', {
        'broker': broker,
        'testnetEnabled': testnetEnabled,
        if (credentials != null) ...credentials,
      });

  Future<Map<String, dynamic>> diagnoseIbkrOAuth() =>
      _call('diagnoseIbkrOAuth', {});

  Future<Map<String, dynamic>> applyAutopilotProposals({
    required String strategyId,
    required String reportId,
    required List<String> acceptedProposalIds,
  }) =>
      _call('applyAutopilotProposals', {
        'strategyId': strategyId,
        'reportId': reportId,
        'acceptedProposalIds': acceptedProposalIds,
      });

  Future<Map<String, dynamic>> runMonteCarlo({
    required String strategyId,
    required double startingCapitalUsd,
    required int periodDays,
  }) =>
      _call('runMonteCarlo', {
        'strategyId': strategyId,
        'startingCapitalUsd': startingCapitalUsd,
        'periodDays': periodDays,
      });

  Future<Map<String, dynamic>> generateReplaySession({
    required String strategyId,
    required DateTime startDate,
    required DateTime endDate,
  }) =>
      _call('generateReplaySession', {
        'strategyId': strategyId,
        'startDate': startDate.toIso8601String(),
        'endDate': endDate.toIso8601String(),
      });

  Future<Map<String, dynamic>> resolveConflict({
    required String conflictId,
    required String resolution,
  }) =>
      _call('resolveConflict', {
        'conflictId': conflictId,
        'resolution': resolution,
      });

  Future<Map<String, dynamic>> updateConflictResolutionRule(String rule) =>
      _call('updateConflictResolution', {'rule': rule});

  Future<Map<String, dynamic>> generateTradeExport({
    String? strategyId,
    Map<String, dynamic>? filters,
  }) =>
      _call('generateTradeExport', {
        if (strategyId != null) 'strategyId': strategyId,
        if (filters != null) 'filters': filters,
      });

  Future<Map<String, dynamic>> adminAction({
    required String action,
    required String targetUserId,
    Map<String, dynamic>? payload,
  }) =>
      _call('adminAction', {
        'action': action,
        'targetUserId': targetUserId,
        if (payload != null) 'payload': payload,
      });

  Future<Map<String, dynamic>> getAdminTransactions(
          Map<String, dynamic> filters) =>
      _call('getAdminTransactions', filters);

  Future<Map<String, dynamic>> completeOnboarding() =>
      _call('completeOnboarding', {});

  Future<Map<String, dynamic>> triggerAutopilotAnalysis(String strategyId) =>
      _call('triggerAutopilotAnalysis', {'strategyId': strategyId});

  Future<Map<String, dynamic>> promoteShadowConfig({
    required String strategyId,
    required String shadowId,
  }) =>
      _call('promoteShadowConfig', {
        'strategyId': strategyId,
        'shadowId': shadowId,
      });
}

String friendlyCloudFunctionError(
  String code,
  String? message, [
  Object? details,
]) {
  if (code == 'resource-exhausted') {
    if (details is Map) {
      final retry = details['retryAfterSeconds'];
      if (retry is num && retry > 0) {
        final mins = (retry / 60).ceil();
        if (mins <= 1) {
          return 'Too many requests. Try again in about a minute.';
        }
        return 'Too many requests. Try again in about $mins minutes.';
      }
    }
    return 'Too many requests. Please wait a few minutes and try again.';
  }

  return switch (code) {
    'unauthenticated' => 'Please log in again.',
    'unavailable' => 'Service temporarily unavailable. Try again in a minute.',
    'invalid-argument' => 'Invalid input: ${message ?? ''}',
    'failed-precondition' => message ?? 'Action not allowed right now.',
    'internal' => message ?? 'Something went wrong. Please try again.',
    _ => message ?? 'Something went wrong. Please try again.',
  };
}
