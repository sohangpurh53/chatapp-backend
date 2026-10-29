const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const games = require('../controllers/gameController');

const limiter = createRateLimiter({ name: 'games', windowMs: 60 * 1000, max: 120 });

router.use(authenticateToken, limiter);

router.get('/catalog', games.getCatalog);
router.get('/sessions/:sessionId', games.getSession);
router.get('/chats/:chatId/open', games.getOpenSession);

module.exports = router;
