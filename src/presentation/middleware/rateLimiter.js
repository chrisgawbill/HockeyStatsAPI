const rateLimit = require('express-rate-limit');

/**
 * Limiter for the AI endpoint: 10 requests per 15 minutes per IP, answered as
 * JSON so the frontend's error path stays uniform.
 */
const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res
      .status(429)
      .json({ error: 'Too many requests, please try again later.' });
  },
});

module.exports = { aiRateLimiter };
