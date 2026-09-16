const { withTransaction } = require('#platform/pool.js');
const aiSummariesRepository = require('#slices/aiSummaries/aiSummaryRepository.js');
const {
  buildAiSummary,
  hashPrompt,
} = require('#slices/aiSummaries/mappers/aiSummaryDbMapper.js');

async function persistAiSummary({
  teamId = null,
  triCode,
  content,
  summaryType = 'team_history',
  promptVersion = 'v1',
  modelProvider = null,
  modelName = null,
  prompt = null,
  promptHash = hashPrompt(prompt),
  sourceNotes = [],
}) {
  const summary = buildAiSummary({
    teamId,
    triCode,
    content,
    summaryType,
    promptVersion,
    modelProvider,
    modelName,
    prompt,
    promptHash,
    sourceNotes,
  });

  return await withTransaction(async (client) => {
    return await aiSummariesRepository.upsertAiSummary(client, summary);
  });
}

/**
 * AI summaries slice service. Owns the cached read of a team-history summary,
 * the call out to the Python generator, and the write-behind persistence of
 * whatever is served.
 *
 * @param {{
 *   cache: typeof import('#platform/cacheManager.js'),
 *   runAIPythonScript: typeof import('#platform/aiRunner.js').runAIPythonScript,
 *   runServiceTask: typeof import('#platform/runServiceTask.js').runServiceTask,
 * }} deps
 */
function createAiSummaryService({ cache, runAIPythonScript, runServiceTask }) {
  const { readCache, writeCache, CACHE_TYPES } = cache;

  /**
   * Queues persistence for a summary that was just served. A 'default' cache key
   * carries no team, so there is nothing to attribute the row to and it is
   * skipped.
   */
  function queuePersistence(cacheKey, content, prompt, triCode) {
    const resolvedTriCode =
      triCode ?? (cacheKey === 'default' ? null : cacheKey);
    if (resolvedTriCode === null) {
      return;
    }

    runServiceTask(`ai summary ${resolvedTriCode}`, () =>
      persistAiSummary({
        triCode: resolvedTriCode,
        content,
        prompt,
        modelProvider: 'anthropic',
      }),
    );
  }

  return {
    /**
     * Cached team-history summary text. On a miss the Python generator runs and
     * its output is cached before being returned.
     */
    async getTeamHistorySummary({ cacheKey, message, triCode }) {
      const cached = await readCache(CACHE_TYPES.AI, cacheKey);
      if (cached !== null) {
        queuePersistence(cacheKey, cached, message, triCode);
        return cached;
      }

      const result = await runAIPythonScript(message);
      await writeCache(CACHE_TYPES.AI, cacheKey, result);
      queuePersistence(cacheKey, result, message, triCode);
      return result;
    },

    persistAiSummary,
  };
}

module.exports = {
  createAiSummaryService,
  persistAiSummary,
};
