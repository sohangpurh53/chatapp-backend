const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// One row per "blocker blocked blocked". Blocking works both ways in effect: neither
// side can message or call the other (see utils/blocks.js).
const UserBlock = sequelize.define('UserBlock', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  blockerId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE'
  },
  blockedId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE'
  }
}, {
  indexes: [
    { unique: true, fields: ['blockerId', 'blockedId'] },
    { fields: ['blockedId'] }
  ]
});

module.exports = UserBlock;
