const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * One round of an in-chat game. The server is the authority: `state` holds the
 * prompts, the correct answers and every answer with its server-measured time,
 * so it is never sent to apps as is (see services/games/engine viewFor).
 * Game data is not end-to-end encrypted.
 */
const GameSession = sequelize.define('GameSession', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  chatId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Chats', key: 'id' },
    onDelete: 'CASCADE'
  },
  gameType: {
    type: DataTypes.STRING(40),
    allowNull: false
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' }
  },
  // Can change: the host role passes on when the host leaves
  hostId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('lobby', 'active', 'completed', 'cancelled', 'abandoned'),
    allowNull: false,
    defaultValue: 'lobby'
  },
  // expired | host_cancelled | host_left | declined | everyone_left | inactive
  endReason: {
    type: DataTypes.STRING(30),
    allowNull: true
  },
  // A 1:1 chat (the other person declining ends the invite)
  direct: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  // [{ userId, username, avatar, status, playing, score, rank, joinedAt }]
  players: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: []
  },
  state: {
    type: DataTypes.JSON,
    allowNull: true
  },
  // A custom game's own prompts { title, prompts, rounds, roundSeconds }, copied
  // in at creation so later edits to the saved game never change a running one
  content: {
    type: DataTypes.JSON,
    allowNull: true
  },
  // Bumped on every change; apps drop updates older than what they have
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  // When the session's clock next moves it on (lobby expiry, end of a phase)
  deadline: {
    type: DataTypes.DATE,
    allowNull: true
  },
  startedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  endedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // The invite card in the chat timeline, and the result card once it ends
  cardMessageId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  resultMessageId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  rematchOfId: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  indexes: [
    { fields: ['chatId', 'status'] },
    { fields: ['status', 'deadline'] }
  ]
});

module.exports = GameSession;
