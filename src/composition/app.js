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
const {
  createFavoritesRouter,
  createAfterActionReportsRouter,
} = require('#presentation/routes/afterActionReports.js');
const { createPushRouter } = require('#presentation/routes/push.js');
const {
  createFavoritePlayersRouter,
  createWeeklyPlayerReportsRouter,
} = require('#presentation/routes/weeklyPlayerReports.js');
const { createRivalriesRouter } = require('#presentation/routes/rivalries.js');
const { createRinkQuestRouter } = require('#presentation/routes/rinkQuest.js');

/**
 * CORS settings. 'Authorization' is allowed for the bearer-token Google-account
 * routes; this stays a bearer-token API, not a cookie session, so there is no
 * `credentials` option.
 */
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://chrisgawbill.github.io',
  ],
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
  app.use('/rivalries', createRivalriesRouter(container));
  app.use('/rink-quest', createRinkQuestRouter(container));
  app.use('/python-service', createAiRouter(container));
  app.use('/api/auth', createAuthRouter(container));
  app.use('/api/board-game', createBoardGameRouter(container));
  app.use('/api/favorites', createFavoritesRouter(container));
  app.use(
    '/api/after-action-reports',
    createAfterActionReportsRouter(container),
  );
  app.use('/api/push', createPushRouter(container));
  app.use('/api/favorite-players', createFavoritePlayersRouter(container));
  app.use(
    '/api/weekly-player-reports',
    createWeeklyPlayerReportsRouter(container),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
