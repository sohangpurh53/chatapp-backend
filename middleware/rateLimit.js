// Small fixed-window rate limiter keyed by user (or IP before login).
// In-memory: each server instance counts on its own, which is enough to stop
// a client from hammering expensive endpoints. Move the counters to Redis if
// strict limits across several instances are ever needed.

const createRateLimiter = ({ windowMs, max, name = 'default', message = 'Too many requests. Try again shortly.' }) => {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, Math.max(windowMs, 30000));
  sweep.unref?.();

  const middleware = (req, res, next) => {
    const key = `${name}:${req.user?.id || req.ip || 'anonymous'}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message, code: 'TOO_MANY_REQUESTS', retryAfter });
    }
    return next();
  };
  middleware.reset = () => hits.clear();
  return middleware;
};

module.exports = { createRateLimiter };
