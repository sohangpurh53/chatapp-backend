const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * "Can you beat my score?": a chat card one member answers with a solo round.
 * In a group the first person to accept takes it; in a 1:1 chat it's the other
 * person's. Never sends a push: it just waits in the chat until it expires.
 */
const GameChallenge = sequelize.define('GameChallenge', {
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
  challengerId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE'
  },
  challengerName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // The game whose score is being challenged
  sourceSessionId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  gameType: {
    type: DataTypes.STRING(40),
    allowNull: false
  },
  gameName: {
    type: DataTypes.STRING(60),
    allowNull: false
  },
  targetScore: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  // The other person in a 1:1 chat; null in a group until someone accepts
  targetUserId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('pending', 'accepted', 'completed', 'expired', 'dismissed'),
    allowNull: false,
    defaultValue: 'pending'
  },
  takerId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  takerName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  // The solo round, its score, and whether it beat the target
  sessionId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  score: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  beat: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  // Group members who said no thanks: the card stops asking them
  dismissedBy: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: []
  },
  cardMessageId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  indexes: [
    { fields: ['chatId', 'status'] },
    { fields: ['status', 'expiresAt'] },
    { fields: ['takerId', 'status'] }
  ]
});

module.exports = GameChallenge;
