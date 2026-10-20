const rateLimit = require('express-rate-limit');

/** Answers a rate-limited request with a JSON 429. */
function respondTooManyRequests(req, res) {
  res.status(429).json({ error: 'Too many requests, please try again later.' });
}

/**
 * Limiter for the AI endpoint: 10 requests per 15 minutes per IP, answered as
 * JSON so the frontend's error path stays uniform.
 */
const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: respondTooManyRequests,
});

/** Limiter for the cron dispatch endpoint: 20 requests per 15 minutes per IP. */
const dispatchRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: respondTooManyRequests,
});

module.exports = { aiRateLimiter, dispatchRateLimiter };
