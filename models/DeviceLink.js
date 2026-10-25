const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * "Link a new phone": a phone signed in to the account (but without its encryption
 * keys) asks one of the account's other phones for them. The new phone sends a
 * one-time public key; the approving phone sends the account's keys back locked to
 * it (`payload`). The server only relays: it cannot open the payload, and both
 * phones show a code derived from the one-time key, so a swapped key would show.
 * A link lives a few minutes and the payload is handed out once.
 */
const DeviceLink = sequelize.define('DeviceLink', {
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
  // The session (phone) asking for the keys
  requesterSessionId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  requesterName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  linkPublicKey: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  payload: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'declined', 'completed'),
    allowNull: false,
    defaultValue: 'pending'
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  indexes: [{ fields: ['userId'] }]
});

module.exports = DeviceLink;
