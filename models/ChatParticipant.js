const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ChatParticipant = sequelize.define('ChatParticipant', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  userId: {
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
  role: {
    type: DataTypes.ENUM('admin', 'member', 'moderator'),
    defaultValue: 'member'
  },
  joinedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  leftAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  // Individual participant settings
  isMuted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  mutedUntil: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Custom nickname in this chat
  nickname: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Last read message for this participant
  lastReadMessageId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Messages',
      key: 'id'
    }
  },
  // Permissions for group chats
  permissions: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      canSendMessages: true,
      canSendMedia: true,
      canAddMembers: false,
      canRemoveMembers: false,
      canEditGroupInfo: false,
      canPinMessages: false
    }
  }
}, {
  indexes: [
    {
      fields: ['userId', 'chatId'],
      unique: true
    },
    {
      fields: ['chatId']
    },
    {
      fields: ['userId']
    },
    {
      fields: ['isActive']
    }
  ]
});

module.exports = ChatParticipant;