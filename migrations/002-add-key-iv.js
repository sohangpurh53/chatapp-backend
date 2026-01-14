/**
 * Migration: Add keyIv column to Users table
 * 
 * This migration adds the keyIv (initialization vector) column to store
 * the IV used for private key encryption. This fixes the issue where users
 * couldn't decrypt old messages after clearing app data and logging back in.
 */

const { DataTypes } = require('sequelize');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    console.log('🔄 Adding keyIv column to Users table...');
    
    try {
      // Check if column already exists
      const tableDescription = await queryInterface.describeTable('Users');
      
      if (!tableDescription.keyIv) {
        await queryInterface.addColumn('Users', 'keyIv', {
          type: DataTypes.STRING,
          allowNull: true,
          comment: 'Initialization vector for private key encryption'
        });
        console.log('✅ keyIv column added successfully');
      } else {
        console.log('ℹ️ keyIv column already exists, skipping');
      }
      
      // For existing users without keyIv, set it to keySalt for backward compatibility
      const [results] = await queryInterface.sequelize.query(`
        UPDATE "Users" 
        SET "keyIv" = "keySalt" 
        WHERE "keyIv" IS NULL AND "keySalt" IS NOT NULL
      `);
      console.log('✅ Updated existing users with backward-compatible keyIv values');
      
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    console.log('🔄 Removing keyIv column from Users table...');
    
    try {
      const tableDescription = await queryInterface.describeTable('Users');
      
      if (tableDescription.keyIv) {
        await queryInterface.removeColumn('Users', 'keyIv');
        console.log('✅ keyIv column removed successfully');
      } else {
        console.log('ℹ️ keyIv column does not exist, skipping');
      }
    } catch (error) {
      console.error('❌ Rollback failed:', error);
      throw error;
    }
  }
};
