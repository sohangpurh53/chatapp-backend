const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * One AI provider a user has set up (OpenAI, Gemini, Groq, xAI, Ollama or a
 * custom OpenAI-compatible endpoint). The API key is stored encrypted
 * (services/ai/credentialVault) and is never sent back to any client: use
 * services/ai/serialize to turn a row into API output.
 */
const AiProviderConfig = sequelize.define('AiProviderConfig', {
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
  // openai | gemini | groq | xai | ollama | custom (services/ai/registry)
  providerType: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  label: {
    type: DataTypes.STRING(60),
    allowNull: false
  },
  // Only stored for providers whose address can be changed (ollama, custom)
  baseUrl: {
    type: DataTypes.STRING(2048),
    allowNull: true
  },
  encryptedApiKey: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // "••••abcd": lets the user recognise the saved key
  apiKeyHint: {
    type: DataTypes.STRING(16),
    allowNull: true
  },
  defaultModel: {
    type: DataTypes.STRING(200),
    allowNull: true
  },
  enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true
  },
  // Custom endpoints only: 'cloud' | 'self_hosted', as declared by the user
  deploymentType: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  // { streaming?, structuredOutput?, toolCalling?, multimodal? } set by the user
  capabilityOverrides: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {}
  },
  // Optional user-entered price (USD per million tokens) for cost estimates;
  // providers bill differently, so ChatApp never guesses it
  pricePerMillionTokensUsd: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  // Last discovered model list: [{ id, label, capabilities? }]
  models: {
    type: DataTypes.JSON,
    allowNull: true
  },
  modelsFetchedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // 'untested' | 'ok' | 'error'
  status: {
    type: DataTypes.STRING(12),
    allowNull: false,
    defaultValue: 'untested'
  },
  // { code, message } from the last failed test
  lastError: {
    type: DataTypes.JSON,
    allowNull: true
  },
  lastTestedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  indexes: [{ fields: ['userId'] }],
  defaultScope: {
    // Ciphertext only leaves the database when a request explicitly needs it
    attributes: { exclude: ['encryptedApiKey'] }
  },
  scopes: {
    withSecret: { attributes: { include: ['encryptedApiKey'] } }
  }
});

module.exports = AiProviderConfig;
