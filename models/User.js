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
    allowNull: true // nullable: Google-only accounts have no local password
  },
  authProvider: {
    type: DataTypes.ENUM('local', 'google'),
    allowNull: false,
    defaultValue: 'local'
  },
  googleId: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true
  },
  avatar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // Optional personal details. All nullable; who may see each one is in profilePrivacy.
  // Google sign-in fills the three names.
  firstName: { type: DataTypes.STRING(50), allowNull: true },
  middleName: { type: DataTypes.STRING(50), allowNull: true },
  lastName: { type: DataTypes.STRING(50), allowNull: true },
  bio: { type: DataTypes.STRING(300), allowNull: true },
  phone: { type: DataTypes.STRING(32), allowNull: true },
  dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true },
  gender: { type: DataTypes.STRING(20), allowNull: true },
  location: { type: DataTypes.STRING(100), allowNull: true },
  website: { type: DataTypes.STRING(200), allowNull: true },
  // { bio: 'me'|'contacts'|'everyone', ... }; a missing field means 'me'
  profilePrivacy: { type: DataTypes.JSON, allowNull: true },
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
  // "Vibe": short-lived mood shown as an aura around the user's orb {emoji,label,color,expiresAt}
  vibe: {
    type: DataTypes.JSON,
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
      gameInvites: true,
      showGameStats: true,
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
      // Encryption is on whenever there is a public key to encrypt for. A password
      // backup (encryptedPrivateKey) is optional: Google accounts keep the private
      // key on their phone only, and must still receive encrypted messages.
      if (user.changed('publicKey') || user.changed('encryptedPrivateKey')) {
        user.encryptionEnabled = !!user.publicKey;
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
  if (!this.password) return false; // Google-only account, no local password set
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