const mediaService = require('../services/mediaService');
const { Message } = require('../models');
const { Op } = require('sequelize');
const { formatFileSize } = require('../middleware/upload');

/**
 * Upload file
 */
const uploadFile = async (req, res) => {
  try {
    const userId = req.user.id;
    const file = req.file;
    const fileType = req.fileType;

    if (!file) {
      return res.status(400).json({ 
        error: 'No file provided',
        message: 'Please select a file to upload'
      });
    }

    console.log(`📤 User ${userId} uploading ${fileType}: ${file.originalname} (${formatFileSize(file.size)})`);

    // End-to-end encrypted uploads are ciphertext: there is no picture to make a
    // thumbnail of (and the server must not see one)
    const encrypted = req.body?.encrypted === '1';

    // Profile and group photos are stored small; chat attachments are kept as sent
    const isAvatar = req.body?.purpose === 'avatar' && fileType === 'image' && !encrypted;
    let toStore = file;
    if (isAvatar) {
      try {
        toStore = await mediaService.compressAvatar(file);
        console.log(`🗜️  Avatar compressed: ${formatFileSize(file.size)} -> ${formatFileSize(toStore.size)}`);
      } catch (compressError) {
        return res.status(400).json({
          error: 'Invalid image',
          message: 'That file could not be read as an image'
        });
      }
    }

    // Upload to MinIO
    const uploadResult = await mediaService.uploadFile(toStore, userId, fileType);

    // Generate thumbnail for images (an avatar is already small)
    let thumbnailUrl = null;
    if (fileType === 'image' && !encrypted && !isAvatar) {
      thumbnailUrl = await mediaService.generateThumbnail(
        file,
        uploadResult.objectName
      );
    }

    // Generate thumbnail for videos (if implemented)
    if (fileType === 'video' && !encrypted) {
      thumbnailUrl = await mediaService.generateVideoThumbnail(
        file,
        uploadResult.objectName
      );
    }

    console.log(`✅ Upload complete: ${uploadResult.fileUrl}`);

    // Return file information
    res.json({
      success: true,
      message: 'File uploaded successfully',
      file: {
        fileName: uploadResult.fileName,
        fileUrl: uploadResult.fileUrl,
        thumbnailUrl,
        fileSize: uploadResult.fileSize,
        fileSizeFormatted: formatFileSize(uploadResult.fileSize),
        mimeType: uploadResult.mimeType,
        fileType,
        objectName: uploadResult.objectName,
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('❌ Upload file error:', error);
    res.status(500).json({ 
      error: 'Upload failed',
      message: error.message || 'Failed to upload file. Please try again.'
    });
  }
};

/**
 * Delete file
 */
const deleteFile = async (req, res) => {
  try {
    const { objectName, messageId } = req.body;
    const userId = req.user.id;

    if (!objectName && !messageId) {
      return res.status(400).json({ 
        error: 'Missing parameter',
        message: 'Object name or message ID is required'
      });
    }

    let fileObjectName = objectName;

    // If messageId provided, get objectName from message
    if (messageId) {
      const message = await Message.findOne({
        where: {
          id: messageId,
          senderId: userId,
        },
      });

      if (!message) {
        return res.status(404).json({ 
          error: 'Message not found',
          message: 'Message not found or you do not have permission to delete it'
        });
      }

      // Extract objectName from fileUrl
      if (message.fileUrl) {
        const urlParts = message.fileUrl.split('/');
        const bucketIndex = urlParts.indexOf('chatapp-media');
        if (bucketIndex !== -1 && bucketIndex < urlParts.length - 1) {
          fileObjectName = urlParts.slice(bucketIndex + 1).join('/');
        }
      }
    }

    // Message rows can't prove ownership (senders choose their fileUrl); the
    // object key can: every upload is stored under users/<uploaderId>/
    if (fileObjectName && (!fileObjectName.startsWith(`users/${userId}/`) || fileObjectName.includes('..'))) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'You do not have permission to delete this file'
      });
    }

    if (!fileObjectName) {
      return res.status(400).json({ 
        error: 'Invalid file',
        message: 'Could not determine file location'
      });
    }

    console.log(`🗑️  User ${userId} deleting file: ${fileObjectName}`);

    // Delete from MinIO
    await mediaService.deleteFile(fileObjectName);

    console.log(`✅ File deleted successfully`);

    res.json({ 
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete file error:', error);
    res.status(500).json({ 
      error: 'Delete failed',
      message: error.message || 'Failed to delete file. Please try again.'
    });
  }
};

/**
 * Get upload limits and allowed types
 */
const getUploadLimits = async (req, res) => {
  try {
    const { FILE_SIZE_LIMITS, ALLOWED_TYPES } = require('../middleware/upload');

    // Format limits for better readability
    const formattedLimits = {};
    for (const [type, size] of Object.entries(FILE_SIZE_LIMITS)) {
      formattedLimits[type] = {
        bytes: size,
        formatted: formatFileSize(size),
        mb: (size / (1024 * 1024)).toFixed(2),
      };
    }

    res.json({
      success: true,
      limits: formattedLimits,
      allowedTypes: ALLOWED_TYPES,
      bucketName: process.env.MINIO_BUCKET || 'chatapp-media',
    });
  } catch (error) {
    console.error('❌ Get upload limits error:', error);
    res.status(500).json({ 
      error: 'Failed to get limits',
      message: 'Failed to retrieve upload limits'
    });
  }
};

/**
 * Get file metadata
 */
const getFileMetadata = async (req, res) => {
  try {
    const { objectName } = req.params;
    const userId = req.user.id;

    if (!objectName) {
      return res.status(400).json({ 
        error: 'Missing parameter',
        message: 'Object name is required'
      });
    }

    // Verify user has access to this file
    const message = await Message.findOne({
      where: {
        [Op.or]: [
          { senderId: userId },
          { receiverId: userId }
        ],
        fileUrl: { [Op.like]: `%${objectName}%` },
      },
    });

    if (!message) {
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'You do not have permission to access this file'
      });
    }

    const metadata = await mediaService.getFileMetadata(objectName);

    res.json({
      success: true,
      metadata: {
        ...metadata,
        sizeFormatted: formatFileSize(metadata.size),
      },
    });
  } catch (error) {
    console.error('❌ Get file metadata error:', error);
    res.status(500).json({ 
      error: 'Failed to get metadata',
      message: error.message || 'Failed to retrieve file metadata'
    });
  }
};

/**
 * Check MinIO health
 */
const checkHealth = async (req, res) => {
  try {
    const { testConnection } = require('../config/minio');
    const isConnected = await testConnection();

    res.json({
      success: true,
      minioConnected: isConnected,
      bucketName: process.env.MINIO_BUCKET || 'chatapp-media',
      endpoint: process.env.MINIO_ENDPOINT || 'localhost',
      port: process.env.MINIO_PORT || 9000,
    });
  } catch (error) {
    console.error('❌ Health check error:', error);
    res.status(500).json({ 
      success: false,
      minioConnected: false,
      error: error.message
    });
  }
};

module.exports = {
  uploadFile,
  deleteFile,
  getUploadLimits,
  getFileMetadata,
  checkHealth,
};
