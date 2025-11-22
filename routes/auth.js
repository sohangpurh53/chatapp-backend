const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  register,
  login,
  logout,
  getProfile,
  getUserPublicKey,
  uploadKeys,
  getEncryptedPrivateKey
} = require('../controllers/authController');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', authenticateToken, logout);
router.get('/profile', authenticateToken, getProfile);
router.get('/users/:userId/public-key', authenticateToken, getUserPublicKey);

// Encryption key management endpoints
router.post('/keys', authenticateToken, uploadKeys);
router.get('/keys', authenticateToken, getEncryptedPrivateKey);

module.exports = router;