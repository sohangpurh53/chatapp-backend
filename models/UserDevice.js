const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserDevice = sequelize.define('UserDevice', {
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
    },
    onDelete: 'CASCADE'
  },
  deviceId: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Unique device identifier (from React Native DeviceInfo)'
  },
  deviceName: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Human readable device name (e.g., "iPhone 12", "Samsung Galaxy S21")'
  },
  deviceType: {
    type: DataTypes.ENUM('android', 'ios', 'web'),
    allowNull: false,
    defaultValue: 'android'
  },
  platform: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Platform version (e.g., "Android 12", "iOS 15.1")'
  },
  appVersion: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'App version when device was registered'
  },
  fcmToken: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'FCM token for push notifications'
  },
  fcmTokenUpdatedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    comment: 'Whether this device is currently logged in'
  },
  lastLoginAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Last time user logged in from this device'
  },
  lastLogoutAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Last time user logged out from this device'
  },
  lastSeenAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    comment: 'Last activity from this device'
  },
  ipAddress: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Last known IP address'
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'User agent string for web clients'
  },
  notificationPreferences: {
    type: DataTypes.JSON,
    defaultValue: {
      calls: true,
      messages: true,
      groupMessages: true,
      soundEnabled: true,
      vibrationEnabled: true
    },
    comment: 'Device-specific notification preferences'
  }
}, {
  indexes: [
    {
      unique: true,
      fields: ['userId', 'deviceId'],
      name: 'unique_user_device'
    },
    {
      fields: ['userId', 'isActive'],
      name: 'user_active_devices'
    },
    {
      fields: ['fcmToken'],
      name: 'fcm_token_lookup'
    }
  ]
});

module.exports = UserDevice;