const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  avatar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  isOnline: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  lastSeen: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  // Encryption fields
  encryptedPrivateKey: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  publicKey: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  keySalt: {
    type: DataTypes.STRING,
    allowNull: true
  },
  keyVersion: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  keyCreatedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // FCM Push Notification fields
  fcmToken: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fcmTokenUpdatedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  notificationPreferences: {
    type: DataTypes.JSON,
    defaultValue: {
      calls: true,
      messages: true,
      groupMessages: true,
      soundEnabled: true,
      vibrationEnabled: true
    }
  }
}, {
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    }
  }
});

User.prototype.validatePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = User;