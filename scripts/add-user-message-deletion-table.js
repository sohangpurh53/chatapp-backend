const { sequelize, UserMessageDeletion } = require('../models');

async function addUserMessageDeletionTable() {
  try {
    console.log('Creating UserMessageDeletion table...');
    
    // Sync the UserMessageDeletion model (creates table if it doesn't exist)
    await UserMessageDeletion.sync();
    
    console.log('✅ UserMessageDeletion table created successfully!');
    console.log('\nThis table enables "delete for me" functionality.');
    console.log('Messages deleted by a user will be hidden only for that user.');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating UserMessageDeletion table:', error);
    process.exit(1);
  }
}

addUserMessageDeletionTable();
