const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const GroupInvite = sequelize.define('GroupInvite', {
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
  inviterId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  inviteeId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  status: {
    type: DataTypes.ENUM('pending', 'accepted', 'declined', 'expired'),
    defaultValue: 'pending'
  },
  inviteCode: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  indexes: [
    {
      fields: ['chatId']
    },
    {
      fields: ['inviterId']
    },
    {
      fields: ['inviteeId']
    },
    {
      fields: ['inviteCode']
    },
    {
      fields: ['status']
    }
  ]
});

module.exports = GroupInvite;