const crypto = require('crypto');

/** SHA-256 hex digest of the prompt, or null when there is none. */
function hashPrompt(prompt) {
  if (!prompt) return null;
  return crypto.createHash('sha256').update(prompt).digest('hex');
}

/** Builds an ai_summaries entity, hashing the prompt unless a hash is supplied. */
function buildAiSummary({
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
  return {
    teamId,
    triCode,
    summaryType,
    promptVersion,
    modelProvider,
    modelName,
    promptHash,
    content,
    sourceNotes,
  };
}

module.exports = {
  hashPrompt,
  buildAiSummary,
};
