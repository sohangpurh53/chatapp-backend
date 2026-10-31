const AppLog = require("../models/AppLog");

// A log row is an error line, not storage
const MAX_MESSAGE_LENGTH = 5000;
const MAX_PAYLOAD_LENGTH = 20000;
const MAX_LABEL_LENGTH = 20;

/**
 * POST /api/app-logs
 * Store console logs
 */
exports.createLog = async (req, res) => {
  try {
    const { level, message, payload, platform, source } = req.body;

    // ✅ Allow only required console types
    if (!["log", "warn", "error"].includes(level)) {
      return res.status(400).json({ error: "Invalid log level" });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const label = (value) => (typeof value === "string" ? value.slice(0, MAX_LABEL_LENGTH) : undefined);
    const payloadFits = JSON.stringify(payload ?? null).length <= MAX_PAYLOAD_LENGTH;

    const log = await AppLog.create({
      level,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      payload: payloadFits ? payload : null,
      platform: label(platform),
      source: label(source),
    });

    return res.status(201).json({ success: true, id: log.id });
  } catch (err) {
    console.error("APP LOG CREATE ERROR:", err);
    return res.status(500).json({ error: "Failed to store log" });
  }
};

/**
 * GET /api/app-logs
 * Fetch logs using query params
 */
exports.getLogs = async (req, res) => {
  try {
    const where = {};

    // ✔ Query style you requested
    if (req.query["console.log"] === "true") where.level = "log";
    if (req.query["console.warn"] === "true") where.level = "warn";
    if (req.query["console.error"] === "true") where.level = "error";

    const logs = await AppLog.findAll({
      where,
      order: [["created_at", "DESC"]],
      // limit: 200,
    });

    return res.json(logs);
  } catch (err) {
    console.error("APP LOG FETCH ERROR:", err);
    return res.status(500).json({ error: "Failed to fetch logs" });
  }
};
