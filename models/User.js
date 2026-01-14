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
  // Enhanced encryption fields
  encryptedPrivateKey: {
    type: DataTypes.TEXT, // Changed from TEXT to handle larger keys
    allowNull: true
  },
  publicKey: {
    type: DataTypes.TEXT, // Changed from TEXT to handle larger keys
    allowNull: true
  },
  keySalt: {
    type: DataTypes.STRING,
    allowNull: true
  },
  keyIv: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Initialization vector for private key encryption'
  },
  keyVersion: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  keyCreatedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Key rotation history for audit purposes
  keyRotationHistory: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'History of key rotations with timestamps'
  },
  // Enhanced security fields
  encryptionEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Whether user has encryption enabled'
  },
  keyDerivationRounds: {
    type: DataTypes.INTEGER,
    defaultValue: 100000,
    comment: 'PBKDF2 rounds for key derivation'
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
      // Set encryptionEnabled if keys are provided
      if (user.publicKey && user.encryptedPrivateKey) {
        user.encryptionEnabled = true;
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 10);
      }
      // Update encryptionEnabled status
      if (user.changed('publicKey') || user.changed('encryptedPrivateKey')) {
        user.encryptionEnabled = !!(user.publicKey && user.encryptedPrivateKey);
      }
    }
  },
  indexes: [
    {
      fields: ['publicKey'] // New index for public key lookups
    },
    {
      fields: ['encryptionEnabled'] // New index for encryption status
    }
  ]
});

User.prototype.validatePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

// Add method to track key rotation
User.prototype.rotateKeys = async function(newPublicKey, newEncryptedPrivateKey, newKeySalt, newKeyIv) {
  const history = this.keyRotationHistory || [];
  history.push({
    oldKeyVersion: this.keyVersion,
    rotatedAt: new Date(),
    reason: 'manual_rotation'
  });

  await this.update({
    publicKey: newPublicKey,
    encryptedPrivateKey: newEncryptedPrivateKey,
    keySalt: newKeySalt,
    keyIv: newKeyIv || newKeySalt, // Store IV, fallback to keySalt for backward compatibility
    keyVersion: (this.keyVersion || 1) + 1,
    keyCreatedAt: new Date(),
    keyRotationHistory: history,
    encryptionEnabled: true
  });
};

module.exports = User;