const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const {
  register,
  login,
  googleLogin,
  getVibes,
  logout,
  refreshToken,
  getProfile,
  updateProfile,
  getUserPublicKey,
  getUserInfo,
  uploadKeys,
  registerDeviceKey,
  forgotPassword,
  resetPassword,
  getEncryptedPrivateKey,
  updateKeys,
  validateEncryptionSession,
  getEncryptionStats
} = require('../controllers/authController');

router.post('/register', register);
router.post('/login', login);
router.post('/google', googleLogin);
// Public, so limited by IP: asking sends an email, guessing tries a code
router.post('/forgot-password', createRateLimiter({ name: 'forgot-password', windowMs: 15 * 60 * 1000, max: 5 }), forgotPassword);
router.post('/reset-password', createRateLimiter({ name: 'reset-password', windowMs: 15 * 60 * 1000, max: 10 }), resetPassword);
router.post('/refresh', refreshToken); // No auth middleware - refresh token is the credential
router.post('/logout', authenticateToken, logout);
router.get('/sessions', authenticateToken, require('../controllers/authController').getSessions);
router.post('/sessions/revoke-others', authenticateToken, require('../controllers/authController').revokeOtherSessions);
router.delete('/sessions/:sessionId', authenticateToken, require('../controllers/authController').revokeSession);
router.post('/vibes', authenticateToken, getVibes);
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.get('/users/:userId/public-key', authenticateToken, getUserPublicKey);
router.get('/users/:userId', authenticateToken, getUserInfo);

// Enhanced encryption key management endpoints
router.post('/keys', authenticateToken, uploadKeys);
router.post('/device-key', authenticateToken, registerDeviceKey);
router.get('/keys', authenticateToken, getEncryptedPrivateKey);
router.put('/keys', authenticateToken, updateKeys);

// Encryption session management
router.post('/encryption/validate-session', authenticateToken, validateEncryptionSession);
router.get('/encryption/stats', authenticateToken, getEncryptionStats);

module.exports = router;