const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const GroupChatKey = sequelize.define('GroupChatKey', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chatId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Chats',
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
  encryptedGroupKey: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  keyVersion: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  }
}, {
  indexes: [
    {
      unique: true,
      fields: ['chatId', 'userId', 'keyVersion']
    }
  ]
});

module.exports = GroupChatKey;