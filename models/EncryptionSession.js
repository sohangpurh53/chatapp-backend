const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const EncryptionSession = sequelize.define('EncryptionSession', {
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
  sessionToken: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  keyVersion: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  deviceInfo: {
    type: DataTypes.JSON,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  indexes: [
    {
      fields: ['userId', 'isActive']
    },
    {
      fields: ['sessionToken']
    },
    {
      fields: ['expiresAt']
    }
  ]
});

module.exports = EncryptionSession;