const { createContainer } = require('#composition/container.js');
const { createApp } = require('#composition/app.js');

/**
 * Wires the container once and hands back both the app and the services that
 * process-level bootstrap needs (the schedule refresh timer). Kept separate from
 * `app.js` so tests can build an app on stub dependencies.
 */
function bootstrap() {
  const container = createContainer();
  return { app: createApp(container), container };
}

module.exports = { bootstrap };
