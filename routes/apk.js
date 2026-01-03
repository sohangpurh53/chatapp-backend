const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { minioClient } = require('../config/minio');

// Configure multer for APK file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB limit for APK files
  },
  fileFilter: (req, file, cb) => {
    // Only allow APK files
    if (file.mimetype === 'application/vnd.android.package-archive' || 
        file.originalname.toLowerCase().endsWith('.apk')) {
      cb(null, true);
    } else {
      cb(new Error('Only APK files are allowed'), false);
    }
  }
});

// Middleware to verify 64-bit encrypted key
const verifyAPKUploadAuth = (req, res, next) => {
  try {
    const headerKey = req.headers['x-apk-upload-key'];
    const envKey = process.env.APK_UPLOAD_SECRET_KEY;

    if (!headerKey) {
      return res.status(401).json({
        success: false,
        error: 'Missing APK upload authorization key in headers'
      });
    }

    if (!envKey) {
      console.error('APK_UPLOAD_SECRET_KEY not configured in environment');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Create hash of both keys for secure comparison
    const headerHash = crypto.createHash('sha256').update(headerKey).digest('hex');
    const envHash = crypto.createHash('sha256').update(envKey).digest('hex');

    // Use crypto.timingSafeEqual for secure comparison to prevent timing attacks
    const headerBuffer = Buffer.from(headerHash, 'hex');
    const envBuffer = Buffer.from(envHash, 'hex');

    if (headerBuffer.length !== envBuffer.length || 
        !crypto.timingSafeEqual(headerBuffer, envBuffer)) {
      return res.status(403).json({
        success: false,
        error: 'Invalid APK upload authorization key'
      });
    }

    next();
  } catch (error) {
    console.error('APK upload auth verification error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication verification failed'
    });
  }
};

// APK Upload endpoint
router.post('/upload', verifyAPKUploadAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No APK file provided'
      });
    }

    const file = req.file;
    const uploadType = req.body.type || 'android-release';
    
    // Generate unique filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${uploadType}.apk`;
    
    // MinIO bucket for APK files
    const bucketName = process.env.MINIO_BUCKET || 'chatapp-media';
    const objectName = `apk-builds/${filename}`;

    // Upload to MinIO
    await minioClient.putObject(
      bucketName,
      objectName,
      file.buffer,
      file.size,
      {
        'Content-Type': 'application/vnd.android.package-archive',
        'X-Upload-Type': uploadType,
        'X-Upload-Timestamp': new Date().toISOString(),
        'X-Original-Name': file.originalname
      }
    );

    // Generate download URL (expires in 24 hours)
    const downloadUrl = await minioClient.presignedGetObject(bucketName, objectName, 24 * 60 * 60);

    console.log(`✅ APK uploaded successfully: ${objectName} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    res.json({
      success: true,
      message: 'APK uploaded successfully',
      data: {
        filename: filename,
        objectName: objectName,
        size: file.size,
        sizeFormatted: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
        uploadType: uploadType,
        downloadUrl: downloadUrl,
        uploadedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('APK upload error:', error);
    
    // Handle specific multer errors
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          error: 'APK file too large. Maximum size is 100MB'
        });
      }
    }

    res.status(500).json({
      success: false,
      error: 'Failed to upload APK file',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// List uploaded APK files (with auth)
router.get('/list', verifyAPKUploadAuth, async (req, res) => {
  try {
    const bucketName = process.env.MINIO_BUCKET || 'chatapp-media';
    const prefix = 'apk-builds/';
    
    const objectsStream = minioClient.listObjects(bucketName, prefix, true);
    const objects = [];

    objectsStream.on('data', (obj) => {
      objects.push({
        name: obj.name,
        size: obj.size,
        sizeFormatted: `${(obj.size / 1024 / 1024).toFixed(2)} MB`,
        lastModified: obj.lastModified,
        etag: obj.etag
      });
    });

    objectsStream.on('end', () => {
      // Sort by last modified (newest first)
      objects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
      
      res.json({
        success: true,
        data: {
          builds: objects,
          count: objects.length
        }
      });
    });

    objectsStream.on('error', (error) => {
      console.error('Error listing APK files:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list APK files'
      });
    });

  } catch (error) {
    console.error('APK list error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve APK list'
    });
  }
});

// Download APK file (with auth)
router.get('/download/:filename', verifyAPKUploadAuth, async (req, res) => {
  try {
    const filename = req.params.filename;
    const bucketName = process.env.MINIO_BUCKET || 'chatapp-media';
    const objectName = `apk-builds/${filename}`;

    // Check if file exists
    try {
      await minioClient.statObject(bucketName, objectName);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: 'APK file not found'
      });
    }

    // Generate download URL (expires in 1 hour)
    const downloadUrl = await minioClient.presignedGetObject(bucketName, objectName, 60 * 60);

    res.json({
      success: true,
      data: {
        filename: filename,
        downloadUrl: downloadUrl,
        expiresIn: '1 hour'
      }
    });

  } catch (error) {
    console.error('APK download error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate download URL'
    });
  }
});

// Health check for APK upload service
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'APK Upload Service',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    features: {
      upload: true,
      list: true,
      download: true,
      security: '64-bit encrypted key authentication'
    }
  });
});

module.exports = router;