const path = require('path');
const { loadConfig } = require('./config.js');
const { createStore } = require('./store.js');
const { createDeliveryWorker } = require('./deliveryWorker.js');
const { createScheduler, validateSchedules } = require('./scheduler.js');
const { createServer } = require('./server.js');

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Loads the config, then starts the delivery worker, the scheduler and the HTTP API. */
function main() {
  const configPath = path.resolve(process.env.NOTIFIER_CONFIG || 'notifier.json');
  const config = loadConfig(configPath);
  validateSchedules(config.apps);

  const store = createStore(config.databasePath);
  const deliveryWorker = createDeliveryWorker({ store, apps: config.apps });
  const scheduler = createScheduler({ store, apps: config.apps });
  const server = createServer({ store, apps: config.apps, deliveryWorker, scheduler });

  deliveryWorker.start();
  scheduler.start();
  const pruneTimer = setInterval(() => store.pruneBefore(Date.now() - RETENTION_MS), PRUNE_INTERVAL_MS);
  const httpServer = server.listen(config.port, config.host, () => {
    console.log(`Notifier listening on ${config.host}:${config.port} (${config.apps.length} app(s)).`);
  });

  const shutDown = () => {
    console.log('Notifier shutting down.');
    scheduler.stop();
    deliveryWorker.stop();
    clearInterval(pruneTimer);
    httpServer.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutDown);
  process.on('SIGINT', shutDown);
}

main();
