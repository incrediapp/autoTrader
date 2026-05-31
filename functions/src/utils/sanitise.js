function sanitiseForPrompt(userInput, maxLength = 2000) {
  if (typeof userInput !== 'string') return '';

  let safe = userInput.slice(0, maxLength);
  safe = safe.replace(/<[^>]*>/g, '');

  const injectionPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions/gi,
    /disregard\s+(all\s+)?rules/gi,
    /you\s+are\s+now\s+/gi,
    /new\s+system\s+prompt/gi,
    /override\s+/gi,
    /\[system\]/gi,
    /\[assistant\]/gi,
    /<system>/gi,
    /<\/system>/gi,
    /act\s+as\s+(if\s+)?/gi,
  ];

  for (const pattern of injectionPatterns) {
    safe = safe.replace(pattern, '[filtered]');
  }

  return safe.trim();
}

function maskSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  const sensitivePatterns = [
    /api.?key/i, /secret/i, /token/i, /password/i, /auth/i,
  ];

  const masked = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const key of Object.keys(masked)) {
    if (sensitivePatterns.some((p) => p.test(key))) {
      masked[key] = '[REDACTED]';
    } else if (typeof masked[key] === 'object' && masked[key] !== null) {
      masked[key] = maskSecrets(masked[key]);
    }
  }

  return masked;
}

function sanitiseMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v === 'string' && v.length > 500) {
      out[k] = v.slice(0, 500) + '…';
    } else if (typeof v === 'object' && v !== null) {
      out[k] = maskSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitiseErrorForClient(message) {
  if (!message) return 'An error occurred';
  return String(message)
    .replace(/api[_-]?key[=:\s][^\s]*/gi, '[redacted]')
    .replace(/api[_-]?secret[=:\s][^\s]*/gi, '[redacted]')
    .slice(0, 300);
}

module.exports = {
  sanitiseForPrompt,
  maskSecrets,
  sanitiseMetadata,
  sanitiseErrorForClient,
};
