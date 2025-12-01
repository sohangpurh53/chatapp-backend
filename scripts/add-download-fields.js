const { sequelize } = require('../models');

async function addDownloadFields() {
  try {
    console.log('Adding download tracking fields to Messages table...');

    // Add participant1Downloaded field
    await sequelize.query(`
      ALTER TABLE Messages 
      ADD COLUMN IF NOT EXISTS participant1Downloaded BOOLEAN DEFAULT FALSE;
    `);
    console.log('✅ Added participant1Downloaded field');

    // Add participant2Downloaded field
    await sequelize.query(`
      ALTER TABLE Messages 
      ADD COLUMN IF NOT EXISTS participant2Downloaded BOOLEAN DEFAULT FALSE;
    `);
    console.log('✅ Added participant2Downloaded field');

    // Add downloadedBy field for group chats (if not exists)
    await sequelize.query(`
      ALTER TABLE Messages 
      ADD COLUMN IF NOT EXISTS downloadedBy JSON DEFAULT NULL;
    `);
    console.log('✅ Added downloadedBy field');

    console.log('✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

addDownloadFields();
