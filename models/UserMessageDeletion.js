const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * UserMessageDeletion Model
 * Tracks which users have deleted which messages (for "delete for me" functionality)
 * This allows messages to be hidden for specific users without affecting others
 */
const UserMessageDeletion = sequelize.define('UserMessageDeletion', {
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
  messageId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Messages',
      key: 'id'
    }
  },
  deletedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  indexes: [
    {
      fields: ['userId', 'messageId'],
      unique: true // Prevent duplicate entries
    },
    {
      fields: ['messageId']
    }
  ]
});

module.exports = UserMessageDeletion;
