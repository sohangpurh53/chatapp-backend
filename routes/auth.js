const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  register,
  login,
  logout,
  refreshToken,
  getProfile,
  updateProfile,
  getUserPublicKey,
  getUserInfo,
  uploadKeys,
  getEncryptedPrivateKey,
  updateKeys,
  validateEncryptionSession,
  getEncryptionStats
} = require('../controllers/authController');

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refreshToken); // No auth middleware - refresh token is the credential
router.post('/logout', authenticateToken, logout);
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.get('/users/:userId/public-key', authenticateToken, getUserPublicKey);
router.get('/users/:userId', authenticateToken, getUserInfo);

// Enhanced encryption key management endpoints
router.post('/keys', authenticateToken, uploadKeys);
router.get('/keys', authenticateToken, getEncryptedPrivateKey);
router.put('/keys', authenticateToken, updateKeys);

// Encryption session management
router.post('/encryption/validate-session', authenticateToken, validateEncryptionSession);
router.get('/encryption/stats', authenticateToken, getEncryptionStats);

module.exports = router;