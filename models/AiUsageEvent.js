const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * One AI request a user made. Used for usage limits and the usage summary.
 * Never stores prompts, drafts, message text or provider answers.
 */
const AiUsageEvent = sequelize.define('AiUsageEvent', {
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
  // assistant | replies | memory | actions | translation
  feature: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  // assistant action (rewrite, translate, ...) when there is one
  action: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  // Kept even if the provider is later deleted (no foreign key)
  providerId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  providerType: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  model: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  inputTokens: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  outputTokens: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  latencyMs: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  // 'ok' | 'error'
  status: {
    type: DataTypes.STRING(10),
    allowNull: false
  },
  errorCode: {
    type: DataTypes.STRING(40),
    allowNull: true
  }
}, {
  updatedAt: false,
  indexes: [{ fields: ['userId', 'createdAt'] }]
});

module.exports = AiUsageEvent;
