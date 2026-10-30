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
router.get('/custom', games.listCustomGames);
router.post('/custom', games.saveCustomGame);
router.put('/custom/:gameId', games.updateCustomGame);
router.delete('/custom/:gameId', games.deleteCustomGame);

module.exports = router;
