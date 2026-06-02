/**
 * Normalize DH prime hex for ibkr-client (expects hex without 0x prefix).
 */
function normalizeDhPrime(raw) {
  if (raw == null || String(raw).trim() === '') {
    throw new Error('IBKR_OAUTH_DH_PRIME is missing');
  }

  let hex = String(raw).replace(/\s/g, '').toLowerCase();
  hex = hex.replace(/^0x/, '');
  if (hex.startsWith('prime')) {
    hex = hex.slice(5);
  }

  if (!/^[0-9a-f]+$/.test(hex) || hex.length < 256) {
    throw new Error(
      `IBKR_OAUTH_DH_PRIME is invalid (${hex.length} hex chars). `
      + 'Regenerate from secrets/ibkr/dhparam.pem (see scripts/generate-ibkr-oauth-keys.sh) '
      + 'and run ./scripts/sync-secrets-from-env.sh --only ibkr',
    );
  }

  return hex;
}

module.exports = {
  normalizeDhPrime,
};
