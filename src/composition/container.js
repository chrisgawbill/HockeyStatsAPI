const cache = require('#platform/cacheManager.js');
const nhlApi = require('#platform/nhlApiClient.js');
const seasons = require('#platform/seasonHelper.js');
const { runServiceTask } = require('#platform/runServiceTask.js');
const { runAIPythonScript } = require('#platform/aiRunner.js');
const { withTransaction } = require('#platform/pool.js');
const googleAuth = require('#platform/googleAuthClient.js');
const discordAuth = require('#platform/discordAuthClient.js');
const emailCrypto = require('#platform/emailCrypto.js');
const sessionJwt = require('#platform/sessionJwt.js');

const {
  createScheduleService,
} = require('#slices/schedule/scheduleService.js');
const {
  createStandingsService,
} = require('#slices/standings/standingsService.js');
const { createTeamService } = require('#slices/teams/teamService.js');
const { createRosterService } = require('#slices/rosters/rosterService.js');
const { createLineService } = require('#slices/lines/lineService.js');
const {
  createPlayerStatsService,
} = require('#slices/players/playerStatsService.js');
const {
  createStatLeaderService,
} = require('#slices/statLeaders/statLeaderService.js');
const {
  createAiSummaryService,
} = require('#slices/aiSummaries/aiSummaryService.js');
const { createAuthService } = require('#slices/auth/authService.js');
const {
  createBoardGameStreakService,
} = require('#slices/boardGameStreak/boardGameStreakService.js');
const {
  createAfterActionReportService,
} = require('#slices/afterActionReports/afterActionReportService.js');
const {
  createWeeklyPlayerReportService,
} = require('#slices/weeklyPlayerReports/weeklyPlayerReportService.js');
const {
  createPushNotificationService,
} = require('#slices/pushNotifications/pushNotificationService.js');
const { createRivalryService } = require('#slices/rivalries/rivalryService.js');

/**
 * Composition root: the one place that knows which concrete platform adapters
 * (HTTP clients, cache, clock/season helpers) each slice service runs on. Nothing
 * below this file reaches for a dependency it was not handed; routers receive
 * finished services and hold no domain logic of their own.
 *
 * Overrides exist for tests: pass a fake `cache` or `nhlApi` to build the whole
 * graph against stubs without touching module state.
 *
 * @param {Partial<{ cache: any, nhlApi: any, seasons: any, runServiceTask: any, runAIPythonScript: any }>} [overrides]
 */
function createContainer(overrides = {}) {
  const platform = {
    cache,
    nhlApi,
    seasons,
    runServiceTask,
    runAIPythonScript,
    withTransaction,
    googleAuth,
    discordAuth,
    emailCrypto,
    sessionJwt,
    ...overrides,
  };

  const scheduleService = createScheduleService(platform);
  const standingsService = createStandingsService(platform);
  const teamService = createTeamService(platform);
  const rosterService = createRosterService(platform);
  const lineService = createLineService({ ...platform, scheduleService });
  const playerStatsService = createPlayerStatsService(platform);
  const statLeaderService = createStatLeaderService(platform);
  const aiSummaryService = createAiSummaryService(platform);
  const authService = createAuthService(platform);
  const boardGameStreakService = createBoardGameStreakService(platform);
  const afterActionReportService = createAfterActionReportService({
    ...platform,
    scheduleService,
  });
  const weeklyPlayerReportService = createWeeklyPlayerReportService({
    ...platform,
    scheduleService,
  });
  const pushNotificationService = createPushNotificationService({
    ...platform,
    scheduleService,
    afterActionReportService,
    weeklyPlayerReportService,
  });
  const rivalryService = createRivalryService(platform);

  return {
    ...platform,
    scheduleService,
    standingsService,
    teamService,
    rosterService,
    lineService,
    playerStatsService,
    statLeaderService,
    aiSummaryService,
    authService,
    boardGameStreakService,
    afterActionReportService,
    weeklyPlayerReportService,
    pushNotificationService,
    rivalryService,
  };
}

module.exports = { createContainer };
