const express = require("express");
const router = express.Router();
const appLogsController = require("../controllers/appLogsController");

// ✅ ONLY two routes
router.post("/app-logs", appLogsController.createLog);
router.get("/app-logs", appLogsController.getLogs);

module.exports = router;
