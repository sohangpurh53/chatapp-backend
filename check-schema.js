const sequelize = require('./config/database');

async function checkSchema() {
  try {
    console.log('🔍 Checking current database schema...');
    
    // Check Messages table structure
    const [messagesSchema] = await sequelize.query(`
      SELECT column_name, data_type, character_maximum_length 
      FROM information_schema.columns 
      WHERE table_name = 'Messages' 
      AND column_name IN ('content', 'encryptedContent', 'keyId')
      ORDER BY column_name;
    `);
    
    console.log('\n📋 Messages table schema:');
    messagesSchema.forEach(col => {
      console.log(`  ${col.column_name}: ${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ''}`);
    });
    
    // Check Users table structure
    const [usersSchema] = await sequelize.query(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'Users' 
      AND column_name IN ('encryptionEnabled', 'keyDerivationRounds', 'keyRotationHistory')
      ORDER BY column_name;
    `);
    
    console.log('\n📋 Users table encryption fields:');
    if (usersSchema.length === 0) {
      console.log('  ❌ No encryption fields found - migration needed');
    } else {
      usersSchema.forEach(col => {
        console.log(`  ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
      });
    }
    
    // Check if EncryptionSessions table exists
    const [sessionTable] = await sequelize.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name = 'EncryptionSessions';
    `);
    
    console.log('\n📋 EncryptionSessions table:');
    if (sessionTable.length === 0) {
      console.log('  ❌ Table does not exist - migration needed');
    } else {
      console.log('  ✅ Table exists');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Schema check failed:', error);
    process.exit(1);
  }
}

checkSchema();