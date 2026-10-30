const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const ai = require('../controllers/aiController');
const aiAssist = require('../controllers/aiAssistController');

// Every AI route needs a signed-in user. Connection tests and model discovery
// reach out to third-party services, so they get a much tighter limit.
const general = createRateLimiter({ name: 'ai', windowMs: 60 * 1000, max: 120 });
const writes = createRateLimiter({ name: 'ai-write', windowMs: 60 * 1000, max: 30 });
const outbound = createRateLimiter({
  name: 'ai-outbound',
  windowMs: 60 * 1000,
  max: 12,
  message: 'Too many connection tests. Wait a minute and try again.',
});

router.use(authenticateToken, general);

router.get('/config', ai.getConfig);
router.put('/settings', writes, ai.updateSettings);
router.post('/consent', writes, ai.grantConsent);
router.post('/consent/revoke', writes, ai.revokeConsent);
router.post('/providers', writes, ai.createProvider);
router.put('/providers/:providerId', writes, ai.updateProvider);
router.delete('/providers/:providerId', writes, ai.deleteProvider);
router.post('/providers/:providerId/test', outbound, ai.testProvider);
// Message assistant: each call reaches the user's provider
const assistLimiter = createRateLimiter({
  name: 'ai-assist',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many AI requests. Wait a moment and try again.',
});
router.post('/assist', assistLimiter, aiAssist.assist);
router.post('/memory', assistLimiter, aiAssist.ask);
router.post('/actions', assistLimiter, aiAssist.findActions);
// A game is one large request: a smaller budget than the assistant
const gameLimiter = createRateLimiter({ name: 'ai-games', windowMs: 60 * 1000, max: 10, message: 'Too many game requests. Wait a moment.' });
router.post('/games', gameLimiter, aiAssist.createGame);
// Auto-translation can fire for several messages in a row: its own, larger budget
const translateLimiter = createRateLimiter({ name: 'ai-translate', windowMs: 60 * 1000, max: 40, message: 'Too many translations. Wait a moment.' });
router.post('/translate', translateLimiter, aiAssist.translateMessages);

router.get('/providers/:providerId/models', (req, res, next) => (
  req.query.refresh === 'true' || req.query.refresh === '1' ? outbound(req, res, next) : next()
), ai.getProviderModels);

module.exports = router;
