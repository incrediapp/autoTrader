const { defineSecret } = require('firebase-functions/params');

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const newsdataApiKey = defineSecret('NEWSDATA_API_KEY');
const fmpApiKey = defineSecret('FMP_API_KEY');
const ibkrOAuthConsumerKey = defineSecret('IBKR_OAUTH_CONSUMER_KEY');
const ibkrOAuthAccessToken = defineSecret('IBKR_OAUTH_ACCESS_TOKEN');
const ibkrOAuthAccessTokenSecret = defineSecret('IBKR_OAUTH_ACCESS_TOKEN_SECRET');
const ibkrOAuthDhPrime = defineSecret('IBKR_OAUTH_DH_PRIME');
const ibkrOAuthPrivateSignature = defineSecret('IBKR_OAUTH_PRIVATE_SIGNATURE');
const ibkrOAuthPrivateEncryption = defineSecret('IBKR_OAUTH_PRIVATE_ENCRYPTION');

/** Static app secrets — bind on functions so Firebase grants Secret Manager access. */
const appSecrets = [
  anthropicApiKey,
  newsdataApiKey,
  fmpApiKey,
  ibkrOAuthConsumerKey,
  ibkrOAuthAccessToken,
  ibkrOAuthAccessTokenSecret,
  ibkrOAuthDhPrime,
  ibkrOAuthPrivateSignature,
  ibkrOAuthPrivateEncryption,
];

function withAppSecrets(options = {}) {
  return { ...options, secrets: appSecrets };
}

module.exports = {
  appSecrets,
  withAppSecrets,
};
