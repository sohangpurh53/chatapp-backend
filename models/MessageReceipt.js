const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MessageReceipt = sequelize.define('MessageReceipt', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  messageId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Messages',
      key: 'id'
    }
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  status: {
    type: DataTypes.ENUM('delivered', 'read'),
    allowNull: false
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  indexes: [
    {
      fields: ['messageId', 'userId'],
      unique: true
    },
    {
      fields: ['messageId']
    },
    {
      fields: ['userId']
    }
  ]
});

module.exports = MessageReceipt;