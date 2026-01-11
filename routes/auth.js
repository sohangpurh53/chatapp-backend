const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  register,
  login,
  logout,
  getProfile,
  updateProfile,
  getUserPublicKey,
  getUserInfo,
  uploadKeys,
  getEncryptedPrivateKey,
  updateKeys
} = require('../controllers/authController');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', authenticateToken, logout);
router.get('/profile', authenticateToken, getProfile);
router.put('/profile', authenticateToken, updateProfile);
router.get('/users/:userId/public-key', authenticateToken, getUserPublicKey);
router.get('/users/:userId', authenticateToken, getUserInfo);

// Encryption key management endpoints
router.post('/keys', authenticateToken, uploadKeys);
router.get('/keys', authenticateToken, getEncryptedPrivateKey);
router.put('/keys', authenticateToken, updateKeys);

module.exports = router;