const { sequelize } = require('../models');

async function migrateDatabase() {
  try {
    console.log('Starting database migration...');
    
    // Sync all models with the database
    // This will create new tables and add new columns
    await sequelize.sync({ alter: true });
    
    console.log('Database migration completed successfully!');
    console.log('New features added:');
    console.log('- Enhanced Message model with receiverId, status, replyToId, reactions');
    console.log('- Enhanced Chat model with participant IDs for direct chats');
    console.log('- Enhanced ChatParticipant model with permissions and settings');
    console.log('- New MessageReceipt model for read receipts');
    console.log('- New GroupInvite model for group invitations');
    
  } catch (error) {
    console.error('Database migration failed:', error);
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrateDatabase().then(() => {
    process.exit(0);
  });
}

module.exports = migrateDatabase;