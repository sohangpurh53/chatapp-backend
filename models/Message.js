const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Message = sequelize.define('Message', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  content: {
    type: DataTypes.TEXT, // Changed from STRING to TEXT to handle larger content
    allowNull: true
  },
  // Enhanced encrypted content fields for end-to-end encryption
  encryptedContent: {
    type: DataTypes.TEXT, // Changed from JSON to TEXT for larger encrypted payloads
    allowNull: true,
    defaultValue: null
  },
  isEncrypted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  keyId: {
    type: DataTypes.STRING,
    allowNull: true // User ID of the sender for key identification
  },
  // Enhanced encryption fields
  encryptionIv: {
    type: DataTypes.STRING,
    allowNull: true
  },
  authTag: {
    type: DataTypes.STRING,
    allowNull: true
  },
  encryptionAlgorithm: {
    type: DataTypes.STRING,
    defaultValue: 'AES-256-GCM'
  },
  encryptionVersion: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  // Additional encryption metadata
  encryptionMetadata: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Additional encryption metadata (compression, chunking, etc.)'
  },
  messageType: {
    type: DataTypes.ENUM('text', 'image', 'file', 'audio', 'video', 'system'),
    defaultValue: 'text'
  },
  fileUrl: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fileSize: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  isEdited: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  editedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  isDeleted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  deletedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  deletedBy: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  senderId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  chatId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Chats',
      key: 'id'
    }
  },
  // For direct messages, store the receiver ID for easier queries
  receiverId: {
    type: DataTypes.UUID,
    allowNull: true, // null for group messages
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  // Message status for delivery and read receipts
  status: {
    type: DataTypes.ENUM('sent', 'delivered', 'read'),
    defaultValue: 'sent'
  },
  // For reply functionality
  replyToId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Messages',
      key: 'id'
    }
  },
  // For message reactions
  reactions: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null
  },
  // Track file downloads for direct chats
  participant1Downloaded: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Whether participant1 has downloaded this file'
  },
  participant2Downloaded: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Whether participant2 has downloaded this file'
  },
  // For group chats, still use array
  downloadedBy: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: null,
    comment: 'Array of user IDs who have downloaded this file (for group chats)'
  }
}, {
  indexes: [
    {
      fields: ['chatId', 'createdAt']
    },
    {
      fields: ['senderId']
    },
    {
      fields: ['receiverId']
    },
    {
      fields: ['replyToId']
    },
    {
      fields: ['isEncrypted', 'chatId'] // New index for encrypted messages
    },
    {
      fields: ['keyId'] // New index for key-based queries
    }
  ]
});

module.exports = Message;