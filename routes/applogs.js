const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const appLogsController = require("../controllers/appLogsController");
const { createRateLimiter } = require("../middleware/rateLimit");

// Open to apps that aren't signed in yet, so it can't take a login. Behind the proxy all
// phones can count as one address: high enough for real errors, low enough to stop a flood.
const writeLimiter = createRateLimiter({ name: "app-logs", windowMs: 60 * 1000, max: 300 });

// Reading the logs takes the key from APP_LOGS_KEY. Without one set, nobody can.
const requireLogsKey = (req, res, next) => {
  const expected = process.env.APP_LOGS_KEY;
  const given = req.headers["x-app-logs-key"];
  if (!expected || typeof given !== "string" || given.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
};

// ✅ ONLY two routes
router.post("/app-logs", writeLimiter, appLogsController.createLog);
router.get("/app-logs", requireLogsKey, appLogsController.getLogs);

module.exports = router;
