const { minioClient, BUCKET_NAME } = require('../config/minio');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const mime = require('mime-types');

class MediaService {
  /**
   * Upload file to MinIO
   */
  async uploadFile(file, userId, fileType) {
    try {
      const fileExtension = path.extname(file.originalname);
      const fileName = `${uuidv4()}${fileExtension}`;
      const folder = this.getFolder(fileType);
      const objectName = `${folder}/${fileName}`;

      console.log(`📤 Uploading file: ${file.originalname} (${file.size} bytes) as ${objectName}`);

      // Upload to MinIO
      await minioClient.putObject(
        BUCKET_NAME,
        objectName,
        file.buffer,
        file.size,
        {
          'Content-Type': file.mimetype,
          'x-amz-meta-user-id': userId,
          'x-amz-meta-original-name': file.originalname,
          'x-amz-meta-upload-date': new Date().toISOString(),
        }
      );

      console.log(`✅ File uploaded successfully: ${objectName}`);

      // Generate file URL
      const fileUrl = await this.getFileUrl(objectName);

      return {
        fileName: file.originalname,
        storedName: fileName,
        fileUrl,
        objectName,
        fileSize: file.size,
        mimeType: file.mimetype,
      };
    } catch (error) {
      console.error('❌ Upload file error:', error);
      throw new Error(`Failed to upload file: ${error.message}`);
    }
  }

  /**
   * Generate thumbnail for image
   */
  async generateThumbnail(file, objectName) {
    try {
      console.log(`🖼️  Generating thumbnail for: ${objectName}`);

      const thumbnailBuffer = await sharp(file.buffer)
        .resize(200, 200, {
          fit: 'cover',
          position: 'center'
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      const fileExtension = path.extname(objectName);
      const thumbnailName = objectName.replace(fileExtension, '_thumb.jpg');
      const thumbnailObjectName = `thumbnails/${thumbnailName}`;

      await minioClient.putObject(
        BUCKET_NAME,
        thumbnailObjectName,
        thumbnailBuffer,
        thumbnailBuffer.length,
        { 'Content-Type': 'image/jpeg' }
      );

      console.log(`✅ Thumbnail generated: ${thumbnailObjectName}`);

      return await this.getFileUrl(thumbnailObjectName);
    } catch (error) {
      console.error('⚠️  Generate thumbnail error:', error.message);
      return null; // Non-critical, return null if fails
    }
  }

  /**
   * Generate video thumbnail
   */
  async generateVideoThumbnail(file, objectName) {
    try {
      // For now, return null - video thumbnail generation requires ffmpeg
      // This can be implemented later with fluent-ffmpeg
      console.log(`⚠️  Video thumbnail generation not implemented yet for: ${objectName}`);
      return null;
    } catch (error) {
      console.error('⚠️  Generate video thumbnail error:', error.message);
      return null;
    }
  }

  /**
   * Get file URL (presigned or public)
   */
  async getFileUrl(objectName, expirySeconds = 7 * 24 * 60 * 60) {
    try {
      // If public URL is configured, return direct URL
      if (process.env.MINIO_PUBLIC_URL) {
        return `${process.env.MINIO_PUBLIC_URL}/${BUCKET_NAME}/${objectName}`;
      }

      // Generate presigned URL (valid for 7 days by default)
      const url = await minioClient.presignedGetObject(
        BUCKET_NAME,
        objectName,
        expirySeconds
      );

      return url;
    } catch (error) {
      console.error('❌ Get file URL error:', error);
      throw new Error(`Failed to generate file URL: ${error.message}`);
    }
  }

  /**
   * Delete file from MinIO
   */
  async deleteFile(objectName) {
    try {
      console.log(`🗑️  Deleting file: ${objectName}`);

      await minioClient.removeObject(BUCKET_NAME, objectName);
      
      // Try to delete thumbnail if exists
      const fileExtension = path.extname(objectName);
      const thumbnailName = objectName.replace(fileExtension, '_thumb.jpg');
      const thumbnailObjectName = `thumbnails/${thumbnailName}`;
      
      try {
        await minioClient.removeObject(BUCKET_NAME, thumbnailObjectName);
        console.log(`✅ Thumbnail deleted: ${thumbnailObjectName}`);
      } catch (err) {
        // Thumbnail might not exist, ignore error
      }

      console.log(`✅ File deleted successfully: ${objectName}`);
      return true;
    } catch (error) {
      console.error('❌ Delete file error:', error);
      throw new Error(`Failed to delete file: ${error.message}`);
    }
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(objectName) {
    try {
      const stat = await minioClient.statObject(BUCKET_NAME, objectName);
      return {
        size: stat.size,
        etag: stat.etag,
        lastModified: stat.lastModified,
        contentType: stat.metaData['content-type'],
        metadata: stat.metaData,
      };
    } catch (error) {
      console.error('❌ Get file metadata error:', error);
      throw new Error(`Failed to get file metadata: ${error.message}`);
    }
  }

  /**
   * Check if file exists
   */
  async fileExists(objectName) {
    try {
      await minioClient.statObject(BUCKET_NAME, objectName);
      return true;
    } catch (error) {
      if (error.code === 'NotFound') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get folder based on file type
   */
  getFolder(fileType) {
    const folderMap = {
      image: 'images',
      video: 'videos',
      audio: 'audio',
      file: 'documents',
      document: 'documents',
    };
    return folderMap[fileType] || 'documents';
  }

  /**
   * Validate file type
   */
  validateFileType(mimetype, allowedTypes) {
    return allowedTypes.some(type => {
      if (type.endsWith('/*')) {
        const prefix = type.replace('/*', '');
        return mimetype.startsWith(prefix);
      }
      return mimetype === type;
    });
  }

  /**
   * Get file type from mimetype
   */
  getFileType(mimetype) {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    return 'file';
  }

  /**
   * Format file size to human readable
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Compress image before upload
   */
  async compressImage(buffer, quality = 80) {
    try {
      return await sharp(buffer)
        .jpeg({ quality, progressive: true })
        .toBuffer();
    } catch (error) {
      console.error('⚠️  Image compression error:', error.message);
      return buffer; // Return original if compression fails
    }
  }
}

module.exports = new MediaService();
