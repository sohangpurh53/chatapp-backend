const crypto = require('crypto');
const { minioClient } = require('../config/minio');

/**
 * APK Upload Helper Utilities
 * Provides secure utilities for APK file upload operations
 */

class APKUploadHelper {
  constructor() {
    this.bucketName = process.env.MINIO_BUCKET || 'chatapp-media';
    this.apkPrefix = 'apk-builds/';
  }

  /**
   * Generate secure 64-bit encryption key
   * @returns {string} Base64 encoded 64-bit key
   */
  static generateSecureKey() {
    return crypto.randomBytes(64).toString('base64');
  }

  /**
   * Verify APK upload authorization key
   * @param {string} headerKey - Key from request header
   * @param {string} envKey - Key from environment variable
   * @returns {boolean} - True if keys match
   */
  static verifyUploadKey(headerKey, envKey) {
    if (!headerKey || !envKey) {
      return false;
    }

    try {
      // Create secure hashes for comparison
      const headerHash = crypto.createHash('sha256').update(headerKey).digest('hex');
      const envHash = crypto.createHash('sha256').update(envKey).digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      const headerBuffer = Buffer.from(headerHash, 'hex');
      const envBuffer = Buffer.from(envHash, 'hex');

      return headerBuffer.length === envBuffer.length && 
             crypto.timingSafeEqual(headerBuffer, envBuffer);
    } catch (error) {
      console.error('Key verification error:', error);
      return false;
    }
  }

  /**
   * Generate unique APK filename
   * @param {string} type - Upload type (e.g., 'android-release', 'android-debug')
   * @param {string} originalName - Original filename
   * @returns {string} - Unique filename
   */
  static generateAPKFilename(type = 'android-release', originalName = '') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const version = this.extractVersionFromFilename(originalName);
    const versionSuffix = version ? `-v${version}` : '';
    
    return `${type}${versionSuffix}-${timestamp}.apk`;
  }

  /**
   * Extract version from APK filename if present
   * @param {string} filename - Original filename
   * @returns {string|null} - Version string or null
   */
  static extractVersionFromFilename(filename) {
    if (!filename) return null;
    
    // Common version patterns in APK filenames
    const versionPatterns = [
      /v?(\d+\.\d+\.\d+)/i,  // v1.2.3 or 1.2.3
      /version[_-]?(\d+\.\d+\.\d+)/i,  // version_1.2.3
      /-(\d+\.\d+\.\d+)-/i,  // -1.2.3-
    ];

    for (const pattern of versionPatterns) {
      const match = filename.match(pattern);
      if (match) {
        return match[1];
      }
    }
    
    return null;
  }

  /**
   * Validate APK file
   * @param {Object} file - Multer file object
   * @returns {Object} - Validation result
   */
  static validateAPKFile(file) {
    const errors = [];
    const maxSize = 100 * 1024 * 1024; // 100MB

    if (!file) {
      errors.push('No file provided');
      return { isValid: false, errors };
    }

    // Check file extension
    if (!file.originalname.toLowerCase().endsWith('.apk')) {
      errors.push('File must have .apk extension');
    }

    // Check MIME type
    if (file.mimetype !== 'application/vnd.android.package-archive' && 
        file.mimetype !== 'application/octet-stream') {
      errors.push('Invalid file type. Only APK files are allowed');
    }

    // Check file size
    if (file.size > maxSize) {
      errors.push(`File too large. Maximum size is ${maxSize / 1024 / 1024}MB`);
    }

    // Check minimum size (APK files should be at least 1MB)
    if (file.size < 1024 * 1024) {
      errors.push('File too small. APK files should be at least 1MB');
    }

    return {
      isValid: errors.length === 0,
      errors,
      fileInfo: {
        size: file.size,
        sizeFormatted: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
        originalName: file.originalname,
        mimetype: file.mimetype
      }
    };
  }

  /**
   * Upload APK to MinIO with metadata
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} filename - Target filename
   * @param {Object} metadata - Additional metadata
   * @returns {Promise<Object>} - Upload result
   */
  async uploadAPK(fileBuffer, filename, metadata = {}) {
    try {
      const objectName = `${this.apkPrefix}${filename}`;
      
      const uploadMetadata = {
        'Content-Type': 'application/vnd.android.package-archive',
        'X-Upload-Timestamp': new Date().toISOString(),
        'X-File-Type': 'apk',
        ...metadata
      };

      await minioClient.putObject(
        this.bucketName,
        objectName,
        fileBuffer,
        fileBuffer.length,
        uploadMetadata
      );

      return {
        success: true,
        objectName,
        filename,
        size: fileBuffer.length,
        metadata: uploadMetadata
      };
    } catch (error) {
      console.error('APK upload error:', error);
      throw new Error(`Failed to upload APK: ${error.message}`);
    }
  }

  /**
   * Generate download URL for APK
   * @param {string} filename - APK filename
   * @param {number} expirySeconds - URL expiry time in seconds (default: 1 hour)
   * @returns {Promise<string>} - Presigned download URL
   */
  async generateDownloadURL(filename, expirySeconds = 3600) {
    try {
      const objectName = `${this.apkPrefix}${filename}`;
      
      // Check if file exists
      await minioClient.statObject(this.bucketName, objectName);
      
      // Generate presigned URL
      const downloadUrl = await minioClient.presignedGetObject(
        this.bucketName, 
        objectName, 
        expirySeconds
      );

      return downloadUrl;
    } catch (error) {
      if (error.code === 'NotFound') {
        throw new Error('APK file not found');
      }
      throw new Error(`Failed to generate download URL: ${error.message}`);
    }
  }

  /**
   * List all uploaded APK files
   * @param {number} limit - Maximum number of files to return
   * @returns {Promise<Array>} - List of APK files
   */
  async listAPKFiles(limit = 50) {
    try {
      const objectsStream = minioClient.listObjects(this.bucketName, this.apkPrefix, true);
      const objects = [];

      return new Promise((resolve, reject) => {
        objectsStream.on('data', (obj) => {
          if (objects.length < limit) {
            objects.push({
              name: obj.name.replace(this.apkPrefix, ''),
              fullPath: obj.name,
              size: obj.size,
              sizeFormatted: `${(obj.size / 1024 / 1024).toFixed(2)} MB`,
              lastModified: obj.lastModified,
              etag: obj.etag
            });
          }
        });

        objectsStream.on('end', () => {
          // Sort by last modified (newest first)
          objects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
          resolve(objects);
        });

        objectsStream.on('error', (error) => {
          reject(new Error(`Failed to list APK files: ${error.message}`));
        });
      });
    } catch (error) {
      throw new Error(`Failed to list APK files: ${error.message}`);
    }
  }

  /**
   * Delete APK file
   * @param {string} filename - APK filename to delete
   * @returns {Promise<boolean>} - Success status
   */
  async deleteAPK(filename) {
    try {
      const objectName = `${this.apkPrefix}${filename}`;
      await minioClient.removeObject(this.bucketName, objectName);
      return true;
    } catch (error) {
      console.error('APK deletion error:', error);
      throw new Error(`Failed to delete APK: ${error.message}`);
    }
  }

  /**
   * Get APK file metadata
   * @param {string} filename - APK filename
   * @returns {Promise<Object>} - File metadata
   */
  async getAPKMetadata(filename) {
    try {
      const objectName = `${this.apkPrefix}${filename}`;
      const stat = await minioClient.statObject(this.bucketName, objectName);
      
      return {
        name: filename,
        size: stat.size,
        sizeFormatted: `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
        lastModified: stat.lastModified,
        etag: stat.etag,
        metadata: stat.metaData || {}
      };
    } catch (error) {
      if (error.code === 'NotFound') {
        throw new Error('APK file not found');
      }
      throw new Error(`Failed to get APK metadata: ${error.message}`);
    }
  }
}

module.exports = APKUploadHelper;