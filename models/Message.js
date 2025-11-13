const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Message = sequelize.define('Message', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: true
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
    }
  ]
});

module.exports = Message;