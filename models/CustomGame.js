const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * A game a user approved and saved. Private to its owner until they start it in
 * a chat, when a copy of its content goes into that session. Drafts are never
 * stored: they stay on the phone until the user saves one.
 * Shape and validation live in services/games/customGames.
 */
const CustomGame = sequelize.define('CustomGame', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE'
  },
  title: {
    type: DataTypes.STRING(60),
    allowNull: false
  },
  // 'quiz' | 'poll'
  format: {
    type: DataTypes.STRING(12),
    allowNull: false
  },
  rules: {
    type: DataTypes.STRING(300),
    allowNull: true
  },
  // Built from chat messages, so it holds real names and never goes back to AI
  fromConversation: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  roundSeconds: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  // [{ id, question, options, answer }]
  rounds: {
    type: DataTypes.JSON,
    allowNull: false
  }
}, {
  indexes: [
    { fields: ['userId', 'updatedAt'] }
  ]
});

module.exports = CustomGame;
