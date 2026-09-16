require('dotenv').config();
const compression = require('compression');
const cors = require('cors');
const express = require('express');
const path = require('path');
const logger = require('morgan');
const helmet = require('helmet');

const {
  notFoundHandler,
  errorHandler,
} = require('#presentation/middleware/errorHandler.js');
const { createHealthRouter } = require('#presentation/routes/health.js');
const { createStandingsRouter } = require('#presentation/routes/standings.js');
const { createPlayerRouter } = require('#presentation/routes/player.js');
const { createTeamRouter } = require('#presentation/routes/team.js');
const { createScheduleRouter } = require('#presentation/routes/schedule.js');
const { createAiRouter } = require('#presentation/routes/ai.js');
const { createAuthRouter } = require('#presentation/routes/auth.js');
const { createBoardGameRouter } = require('#presentation/routes/boardGame.js');

const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://chrisgawbill.github.io',
  ],
  // 'Authorization' is required for the bearer-token board-game auth routes
  // (this stays a bearer-token API, not a cookie session: no `credentials`).
  allowedHeaders: ['Content-Type', 'x-diagnostics-key', 'Authorization'],
};

/**
 * Builds the Express app from an already-wired container. Middleware order is
 * load-bearing: compression and CORS before the routers, the 404 catch-all and
 * the JSON error handler after them. `trust proxy` is set so the AI rate limiter
 * keys on the real client IP behind Render-style proxies.
 *
 * @param {ReturnType<typeof import('#composition/container.js').createContainer>} container
 */
function createApp(container) {
  const app = express();
  app.set('trust proxy', 1);

  app.use(compression());
  app.use(cors(corsOptions));
  app.use(logger('dev'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '../../public')));
  app.use(helmet());

  app.use('/health', createHealthRouter(container));
  app.use('/standings', createStandingsRouter(container));
  app.use('/player', createPlayerRouter(container));
  app.use('/team', createTeamRouter(container));
  app.use('/schedule', createScheduleRouter(container));
  app.use('/python-service', createAiRouter(container));
  app.use('/api/auth', createAuthRouter(container));
  app.use('/api/board-game', createBoardGameRouter(container));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
