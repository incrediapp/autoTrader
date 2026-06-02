const { ProxyAgent, setGlobalDispatcher } = require('undici');

let networkConfigured = false;

/** Optional IBKR_HTTP_PROXY / IBKR_HTTPS_PROXY to route api.ibkr.com via a whitelisted IP. */
function configureIbkrNetwork() {
  if (networkConfigured) return;
  const proxy = process.env.IBKR_HTTP_PROXY || process.env.IBKR_HTTPS_PROXY;
  if (proxy) {
    setGlobalDispatcher(new ProxyAgent(proxy));
  }
  networkConfigured = true;
}

async function fetchCloudEgressIp() {
  try {
    configureIbkrNetwork();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.ip === 'string' ? body.ip : null;
  } catch {
    return null;
  }
}

module.exports = {
  configureIbkrNetwork,
  fetchCloudEgressIp,
};
