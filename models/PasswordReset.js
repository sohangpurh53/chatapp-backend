const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * One "forgot password" request. Only a keyed hash of the emailed code is kept,
 * so a database leak does not reveal usable codes. A code works once, expires
 * quickly and is locked after a few wrong guesses (see services/passwordReset).
 */
const PasswordReset = sequelize.define('PasswordReset', {
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
  codeHash: {
    type: DataTypes.STRING,
    allowNull: false
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  usedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  indexes: [{ fields: ['userId'] }]
});

module.exports = PasswordReset;
