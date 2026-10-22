const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * One signed-in device. Its id is the `sid` claim inside the access and
 * refresh tokens, so revoking the row signs that device out everywhere
 * (REST, socket and token refresh).
 */
const UserSession = sequelize.define('UserSession', {
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
  deviceId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  deviceName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  platform: {
    type: DataTypes.STRING,
    allowNull: true
  },
  appVersion: {
    type: DataTypes.STRING,
    allowNull: true
  },
  ipAddress: {
    type: DataTypes.STRING,
    allowNull: true
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  lastActiveAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  revokedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // 'logout' | 'remote' | 'replaced' | 'limit' | 'all_others'
  revokeReason: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  indexes: [
    { fields: ['userId'] },
    { fields: ['userId', 'revokedAt'] },
    { fields: ['deviceId'] }
  ]
});

module.exports = UserSession;
