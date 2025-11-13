const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Chat = sequelize.define('Chat', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true // null for direct chats
  },
  isGroup: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  avatar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  // For direct chats, store both participant IDs for easier queries
  participant1Id: {
    type: DataTypes.UUID,
    allowNull: true, // null for group chats
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  participant2Id: {
    type: DataTypes.UUID,
    allowNull: true, // null for group chats
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  // Group settings
  settings: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      allowMembersToAddOthers: false,
      allowMembersToEditGroupInfo: false,
      muteNotifications: false,
      disappearingMessages: false,
      disappearingMessagesDuration: null
    }
  },
  // Last activity for sorting
  lastActivityAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  // Archive status
  isArchived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  indexes: [
    {
      fields: ['participant1Id', 'participant2Id'],
      unique: true,
      where: {
        isGroup: false
      }
    },
    {
      fields: ['isGroup']
    },
    {
      fields: ['lastActivityAt']
    },
    {
      fields: ['createdBy']
    }
  ]
});

module.exports = Chat;