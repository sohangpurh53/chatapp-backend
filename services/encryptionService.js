/**
 * EncryptionService.js
 * Backend encryption utilities and validation
 * 
 * Handles:
 * - Message encryption validation
 * - Key management utilities
 * - Encryption session management
 * - Security auditing
 */

const crypto = require('crypto');
const { User, EncryptionSession, GroupChatKey } = require('../models');
const { Op } = require('sequelize');

class EncryptionService {
  
  /**
   * Validate encrypted message format
   * @param {Object} encryptedData - Encrypted message data
   * @returns {Object} Validation result
   */
  validateEncryptedMessage(encryptedData) {
    try {
      const required = ['encryptedContent', 'iv', 'algorithm'];
      const missing = required.filter(field => !encryptedData[field]);
      
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Missing required fields: ${missing.join(', ')}`
        };
      }

      // Validate algorithm
      const supportedAlgorithms = ['AES-256-GCM', 'AES-256-CBC'];
      if (!supportedAlgorithms.includes(encryptedData.algorithm)) {
        return {
          valid: false,
          error: `Unsupported encryption algorithm: ${encryptedData.algorithm}`
        };
      }

      // Validate IV length
      if (encryptedData.iv.length !== 32 && encryptedData.iv.length !== 24) { // Support both 16 bytes (32 hex) and 12 bytes (24 hex) for GCM
        return {
          valid: false,
          error: 'Invalid IV length'
        };
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: `Validation error: ${error.message}`
      };
    }
  }

  /**
   * Compress encrypted content if it's too large
   * @param {string} encryptedContent - Base64 encrypted content
   * @returns {Object} Compressed content with metadata
   */
  async compressEncryptedContent(encryptedContent) {
    try {
      const zlib = require('zlib');
      const buffer = Buffer.from(encryptedContent, 'base64');
      
      // Only compress if content is larger than 1KB
      if (buffer.length > 1024) {
        const compressed = zlib.gzipSync(buffer);
        const compressionRatio = compressed.length / buffer.length;
        
        // Only use compression if it saves at least 10%
        if (compressionRatio < 0.9) {
          return {
            content: compressed.toString('base64'),
            compressed: true,
            originalSize: buffer.length,
            compressedSize: compressed.length,
            compressionRatio
          };
        }
      }
      
      return {
        content: encryptedContent,
        compressed: false,
        originalSize: buffer.length
      };
    } catch (error) {
      console.error('Compression error:', error);
      return {
        content: encryptedContent,
        compressed: false,
        error: error.message
      };
    }
  }

  /**
   * Process encrypted content for client consumption
   * Handles decompression and proper formatting
   * @param {string} encryptedContent - Raw encrypted content from database
   * @param {Object} encryptionMetadata - Encryption metadata
   * @returns {Object} Processed encrypted content
   */
  async processEncryptedContentForClient(encryptedContent, encryptionMetadata = null) {
    try {
      if (!encryptedContent) {
        return null;
      }

      let processedContent = encryptedContent;

      // Parse metadata if it's a string
      let metadata = encryptionMetadata;
      if (typeof encryptionMetadata === 'string') {
        try {
          metadata = JSON.parse(encryptionMetadata);
        } catch (error) {
          console.warn('Failed to parse encryption metadata:', error);
          metadata = null;
        }
      }

      // Decompress if needed
      if (metadata && metadata.compressed) {
        try {
          processedContent = await this.decompressEncryptedContent(encryptedContent);
          console.log('✅ Decompressed encrypted content');
        } catch (error) {
          console.error('❌ Failed to decompress encrypted content:', error);
          throw new Error('Failed to decompress encrypted content');
        }
      }

      // Parse JSON if it's a string
      if (typeof processedContent === 'string') {
        try {
          return JSON.parse(processedContent);
        } catch (error) {
          console.warn('Encrypted content is not valid JSON, returning as string');
          return processedContent;
        }
      }

      return processedContent;
    } catch (error) {
      console.error('Error processing encrypted content:', error);
      throw error;
    }
  }

  /**
   * Decompress encrypted content
   * @param {string} compressedContent - Base64 compressed content
   * @returns {string} Decompressed content
   */
  async decompressEncryptedContent(compressedContent) {
    try {
      const zlib = require('zlib');
      const buffer = Buffer.from(compressedContent, 'base64');
      const decompressed = zlib.gunzipSync(buffer);
      return decompressed.toString('base64');
    } catch (error) {
      console.error('Decompression error:', error);
      throw new Error('Failed to decompress content');
    }
  }

  /**
   * Create encryption session for user
   * @param {string} userId - User ID
   * @param {Object} deviceInfo - Device information
   * @returns {Object} Session data
   */
  async createEncryptionSession(userId, deviceInfo = {}) {
    try {
      // Clean up expired sessions
      await this.cleanupExpiredSessions(userId);

      // Generate session token
      const sessionToken = crypto.randomBytes(32).toString('hex');
      
      // Get user's current key version
      const user = await User.findByPk(userId, {
        attributes: ['keyVersion']
      });

      const session = await EncryptionSession.create({
        userId,
        sessionToken,
        keyVersion: user?.keyVersion || 1,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        deviceInfo,
        isActive: true
      });

      return {
        sessionToken,
        expiresAt: session.expiresAt,
        keyVersion: session.keyVersion
      };
    } catch (error) {
      console.error('Create encryption session error:', error);
      throw new Error('Failed to create encryption session');
    }
  }

  /**
   * Validate encryption session
   * @param {string} sessionToken - Session token
   * @returns {Object} Session validation result
   */
  async validateEncryptionSession(sessionToken) {
    try {
      const session = await EncryptionSession.findOne({
        where: {
          sessionToken,
          isActive: true,
          expiresAt: { [Op.gt]: new Date() }
        },
        include: [{
          model: User,
          as: 'user',
          attributes: ['id', 'keyVersion', 'encryptionEnabled']
        }]
      });

      if (!session) {
        return { valid: false, error: 'Invalid or expired session' };
      }

      return {
        valid: true,
        userId: session.userId,
        keyVersion: session.keyVersion,
        user: session.user
      };
    } catch (error) {
      console.error('Validate encryption session error:', error);
      return { valid: false, error: 'Session validation failed' };
    }
  }

  /**
   * Clean up expired sessions
   * @param {string} userId - User ID (optional)
   */
  async cleanupExpiredSessions(userId = null) {
    try {
      const where = {
        [Op.or]: [
          { expiresAt: { [Op.lt]: new Date() } },
          { isActive: false }
        ]
      };

      if (userId) {
        where.userId = userId;
      }

      const deletedCount = await EncryptionSession.destroy({ where });
      
      if (deletedCount > 0) {
        console.log(`🧹 Cleaned up ${deletedCount} expired encryption sessions`);
      }
    } catch (error) {
      console.error('Cleanup expired sessions error:', error);
    }
  }

  /**
   * Rotate group key and update all member keys
   * @param {string} chatId - Chat ID
   * @param {Array} memberKeys - Array of encrypted keys for members
   * @returns {Object} Rotation result
   */
  async rotateGroupKey(chatId, memberKeys) {
    try {
      // Get current key version
      const currentKey = await GroupChatKey.findOne({
        where: { chatId },
        order: [['keyVersion', 'DESC']]
      });

      const newVersion = (currentKey?.keyVersion || 1) + 1;

      // Delete old keys
      await GroupChatKey.destroy({ where: { chatId } });

      // Create new keys for all members
      const keyPromises = memberKeys.map(keyData => 
        GroupChatKey.create({
          chatId,
          userId: keyData.userId,
          encryptedGroupKey: keyData.encryptedKey,
          keyVersion: newVersion
        })
      );

      await Promise.all(keyPromises);

      console.log(`🔄 Rotated group key for chat ${chatId} to version ${newVersion}`);

      return {
        success: true,
        keyVersion: newVersion,
        memberCount: memberKeys.length
      };
    } catch (error) {
      console.error('Rotate group key error:', error);
      throw new Error('Failed to rotate group key');
    }
  }

  /**
   * Audit encryption usage
   * @param {string} userId - User ID (optional)
   * @returns {Object} Audit data
   */
  async auditEncryptionUsage(userId = null) {
    try {
      const { Message } = require('../models');
      
      const where = {};
      if (userId) {
        where.senderId = userId;
      }

      const [totalMessages, encryptedMessages] = await Promise.all([
        Message.count({ where }),
        Message.count({ where: { ...where, isEncrypted: true } })
      ]);

      const encryptionRate = totalMessages > 0 ? (encryptedMessages / totalMessages) * 100 : 0;

      return {
        totalMessages,
        encryptedMessages,
        unencryptedMessages: totalMessages - encryptedMessages,
        encryptionRate: Math.round(encryptionRate * 100) / 100
      };
    } catch (error) {
      console.error('Audit encryption usage error:', error);
      throw new Error('Failed to audit encryption usage');
    }
  }

  /**
   * Get encryption statistics
   * @returns {Object} Encryption statistics
   */
  async getEncryptionStats() {
    try {
      const [
        totalUsers,
        encryptionEnabledUsers,
        totalMessages,
        encryptedMessages,
        activeSessions
      ] = await Promise.all([
        User.count(),
        User.count({ where: { encryptionEnabled: true } }),
        require('../models').Message.count(),
        require('../models').Message.count({ where: { isEncrypted: true } }),
        EncryptionSession.count({ 
          where: { 
            isActive: true,
            expiresAt: { [Op.gt]: new Date() }
          }
        })
      ]);

      return {
        users: {
          total: totalUsers,
          encryptionEnabled: encryptionEnabledUsers,
          encryptionRate: totalUsers > 0 ? (encryptionEnabledUsers / totalUsers) * 100 : 0
        },
        messages: {
          total: totalMessages,
          encrypted: encryptedMessages,
          encryptionRate: totalMessages > 0 ? (encryptedMessages / totalMessages) * 100 : 0
        },
        sessions: {
          active: activeSessions
        }
      };
    } catch (error) {
      console.error('Get encryption stats error:', error);
      throw new Error('Failed to get encryption statistics');
    }
  }

  /**
   * Validate user's encryption setup
   * @param {string} userId - User ID
   * @returns {Object} Validation result
   */
  async validateUserEncryption(userId) {
    try {
      const user = await User.findByPk(userId, {
        attributes: ['publicKey', 'encryptedPrivateKey', 'keySalt', 'encryptionEnabled']
      });

      if (!user) {
        return { valid: false, error: 'User not found' };
      }

      const issues = [];

      if (!user.publicKey) {
        issues.push('Missing public key');
      }

      if (!user.encryptedPrivateKey) {
        issues.push('Missing encrypted private key');
      }

      if (!user.keySalt) {
        issues.push('Missing key salt');
      }

      if (!user.encryptionEnabled) {
        issues.push('Encryption not enabled');
      }

      return {
        valid: issues.length === 0,
        issues,
        encryptionEnabled: user.encryptionEnabled
      };
    } catch (error) {
      console.error('Validate user encryption error:', error);
      return { valid: false, error: 'Validation failed' };
    }
  }
}

module.exports = new EncryptionService();