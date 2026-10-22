const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * A user's AI preferences: the global switch, the default provider and model,
 * per-feature choices and optional usage limits. Kept out of the User row so
 * it never rides along with profile or contact lookups.
 * Shape and validation live in services/ai/settings.
 */
const AiUserSettings = sequelize.define('AiUserSettings', {
  userId: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE'
  },
  enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  defaultProviderId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  defaultModel: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  // { [featureKey]: { enabled, providerId, model } }
  features: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {}
  },
  // { dailyRequestLimit, monthlyTokenLimit, monthlyCostWarningUsd }
  limits: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {}
  }
});

module.exports = AiUserSettings;
