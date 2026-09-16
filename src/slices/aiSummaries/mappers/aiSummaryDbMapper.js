const crypto = require('crypto');

function hashPrompt(prompt) {
  if (!prompt) return null;
  return crypto.createHash('sha256').update(prompt).digest('hex');
}

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
