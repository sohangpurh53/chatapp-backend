const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * One player's outcome of a completed game. Written once, when the session
 * completes; feeds game history and personal bests. Always read together with
 * the chat it belongs to so stats never leave the conversation.
 */
const GameResult = sequelize.define('GameResult', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  sessionId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'GameSessions', key: 'id' },
    onDelete: 'CASCADE'
  },
  chatId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Chats', key: 'id' },
    onDelete: 'CASCADE'
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE'
  },
  gameType: {
    type: DataTypes.STRING(40),
    allowNull: false
  },
  score: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  rank: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  won: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  // Left before the end
  left: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  playerCount: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  indexes: [
    { unique: true, fields: ['sessionId', 'userId'] },
    { fields: ['userId', 'gameType'] },
    { fields: ['chatId', 'gameType'] }
  ]
});

module.exports = GameResult;
