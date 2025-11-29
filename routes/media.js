const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { upload, validateFileSize, handleMulterError } = require('../middleware/upload');
const {
  uploadFile,
  deleteFile,
  getUploadLimits,
  getFileMetadata,
  checkHealth,
} = require('../controllers/mediaController');

// Health check endpoint (no auth required)
router.get('/health', checkHealth);

// Get upload limits and allowed types (requires auth)
router.get('/limits', authenticateToken, getUploadLimits);

// Upload file (requires auth)
router.post(
  '/upload',
  authenticateToken,
  upload.single('file'),
  handleMulterError,
  validateFileSize,
  uploadFile
);

// Delete file (requires auth)
router.delete('/delete', authenticateToken, deleteFile);

// Get file metadata (requires auth)
router.get('/metadata/:objectName', authenticateToken, getFileMetadata);

module.exports = router;
