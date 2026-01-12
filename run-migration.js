const sequelize = require('./config/database');
const migration = require('./migrations/001-enhance-encryption-support');

async function runMigration() {
  try {
    console.log('🔄 Running encryption enhancement migration...');
    
    // Create a mock queryInterface
    const queryInterface = sequelize.getQueryInterface();
    
    // Run the migration
    await migration.up(queryInterface, sequelize.constructor);
    
    console.log('✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigration();