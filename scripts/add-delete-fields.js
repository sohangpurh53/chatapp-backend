const { sequelize } = require('../models');
const { QueryInterface } = require('sequelize');

async function addDeleteFields() {
  const queryInterface = sequelize.getQueryInterface();

  try {
    console.log('Adding delete-related fields to database...');

    // Add fields to Messages table
    try {
      await queryInterface.addColumn('Messages', 'isDeleted', {
        type: sequelize.Sequelize.BOOLEAN,
        defaultValue: false,
        allowNull: false
      });
      console.log('✓ Added isDeleted to Messages');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('- isDeleted already exists in Messages');
      } else {
        throw error;
      }
    }

    try {
      await queryInterface.addColumn('Messages', 'deletedAt', {
        type: sequelize.Sequelize.DATE,
        allowNull: true
      });
      console.log('✓ Added deletedAt to Messages');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('- deletedAt already exists in Messages');
      } else {
        throw error;
      }
    }

    try {
      await queryInterface.addColumn('Messages', 'deletedBy', {
        type: sequelize.Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'Users',
          key: 'id'
        }
      });
      console.log('✓ Added deletedBy to Messages');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('- deletedBy already exists in Messages');
      } else {
        throw error;
      }
    }

    // Add isActive field to Chats table
    try {
      await queryInterface.addColumn('Chats', 'isActive', {
        type: sequelize.Sequelize.BOOLEAN,
        defaultValue: true,
        allowNull: false
      });
      console.log('✓ Added isActive to Chats');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('- isActive already exists in Chats');
      } else {
        throw error;
      }
    }

    console.log('\n✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
addDeleteFields();
