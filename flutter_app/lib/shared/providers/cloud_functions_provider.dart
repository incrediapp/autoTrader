import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/cloud_functions.dart';

final cloudFunctionsProvider = Provider<CloudFunctionsService>((ref) {
  return CloudFunctionsService();
});
