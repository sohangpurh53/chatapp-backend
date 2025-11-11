const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Call = sequelize.define('Call', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  callerId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  receiverId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id'
    }
  },
  chatId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Chats',
      key: 'id'
    }
  },
  callType: {
    type: DataTypes.ENUM('voice', 'video'),
    allowNull: false,
    defaultValue: 'voice'
  },
  status: {
    type: DataTypes.ENUM('initiated', 'ringing', 'answered', 'ended', 'missed', 'declined'),
    allowNull: false,
    defaultValue: 'initiated'
  },
  duration: {
    type: DataTypes.INTEGER, // in seconds
    allowNull: true,
    defaultValue: 0
  },
  startedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  endedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  isGroupCall: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  participants: {
    type: DataTypes.JSON, // Store participant IDs for group calls
    allowNull: true
  },
  recordingUrl: {
    type: DataTypes.STRING,
    allowNull: true
  },
  endReason: {
    type: DataTypes.ENUM('normal', 'busy', 'no_answer', 'network_error', 'user_ended'),
    allowNull: true
  }
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['callerId']
    },
    {
      fields: ['receiverId']
    },
    {
      fields: ['chatId']
    },
    {
      fields: ['status']
    },
    {
      fields: ['createdAt']
    }
  ]
});

module.exports = Call;