const { DataTypes } = require("sequelize");
const sequelize = require("../config/database"); // adjust path

const AppLog = sequelize.define(
  "Applogs",
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },

    level: {
      type: DataTypes.ENUM("log", "warn", "error"),
      allowNull: false,
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    payload: {
      type: DataTypes.JSONB, // ✅ JSON storage
      allowNull: true,
    },

    platform: {
      type: DataTypes.STRING(20),
      defaultValue: "android",
    },

    source: {
      type: DataTypes.STRING(50),
      defaultValue: "react-native",
    },

    app_version: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },

    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "Applogs",
    timestamps: false,
    indexes: [
      { fields: ["level"] },
      { fields: ["created_at"] },
    ],
  }
);

module.exports = AppLog;
