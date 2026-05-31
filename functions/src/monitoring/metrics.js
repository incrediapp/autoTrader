const { getDb, FieldValue } = require('../utils/db');
const { getProjectId } = require('../utils/secrets');

let monitoringClient = null;

function getMonitoringClient() {
  if (!monitoringClient) {
    try {
      const { MetricServiceClient } = require('@google-cloud/monitoring');
      monitoringClient = new MetricServiceClient();
    } catch {
      monitoringClient = null;
    }
  }
  return monitoringClient;
}

async function incrementSystemMetric(field, amount = 1) {
  try {
    await getDb().doc('systemMetrics/current').set({
      [field]: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch {
    // ignore if doc missing in dev
  }
}

async function writeMetric(metricType, value, labels = {}) {
  const client = getMonitoringClient();
  if (!client) return;

  try {
    const now = Date.now();
    await client.createTimeSeries({
      name: client.projectPath(getProjectId()),
      timeSeries: [{
        metric: {
          type: `custom.googleapis.com/ai_auto_trader/${metricType}`,
          labels,
        },
        resource: {
          type: 'global',
          labels: { project_id: getProjectId() },
        },
        points: [{
          interval: { endTime: { seconds: Math.floor(now / 1000) } },
          value: { doubleValue: value },
        }],
      }],
    });
  } catch {
    // monitoring optional in local dev
  }
}

async function buildSystemMetricsSnapshot() {
  const current = (await getDb().doc('systemMetrics/current').get()).data() ?? {};

  const usersSnap = await getDb().collection('users').get();
  const strategiesSnap = await getDb().collectionGroup('strategies').get();

  const activeStrategies = strategiesSnap.docs.filter((d) => d.data().status === 'active');
  const liveStrategies = strategiesSnap.docs.filter((d) => d.data().mode === 'live' && d.data().status === 'active');
  const paperStrategies = strategiesSnap.docs.filter((d) => d.data().mode === 'paper' && d.data().status === 'active');

  return {
    ...current,
    totalUsers: usersSnap.size,
    totalStrategies: strategiesSnap.size,
    activeStrategies: activeStrategies.length,
    liveStrategies: liveStrategies.length,
    paperStrategies: paperStrategies.length,
    pausedStrategies: strategiesSnap.docs.filter((d) => d.data().status === 'paused').length,
    autoPausedStrategies: strategiesSnap.docs.filter((d) => d.data().status === 'auto_paused').length,
    errorRatePctToday: current.cyclesToday > 0
      ? ((current.errorCyclesToday ?? 0) / current.cyclesToday) * 100
      : 0,
  };
}

module.exports = {
  incrementSystemMetric,
  writeMetric,
  buildSystemMetricsSnapshot,
};
