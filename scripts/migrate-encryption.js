const { sequelize } = require('../models');

async function migrateEncryption() {
  try {
    console.log('Starting encryption migration...');

    // Add encryption columns to Users table
    await sequelize.query(`
      ALTER TABLE Users 
      ADD COLUMN IF NOT EXISTS encryptedPrivateKey TEXT,
      ADD COLUMN IF NOT EXISTS publicKey TEXT,
      ADD COLUMN IF NOT EXISTS keySalt VARCHAR(255),
      ADD COLUMN IF NOT EXISTS keyVersion INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS keyCreatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    console.log('Added encryption columns to Users table');

    // Add encryption columns to Messages table
    await sequelize.query(`
      ALTER TABLE Messages 
      ADD COLUMN IF NOT EXISTS encryptionIv VARCHAR(255),
      ADD COLUMN IF NOT EXISTS authTag VARCHAR(255),
      ADD COLUMN IF NOT EXISTS encryptionAlgorithm VARCHAR(50) DEFAULT 'AES-256-GCM',
      ADD COLUMN IF NOT EXISTS encryptionVersion INTEGER DEFAULT 1;
    `);

    console.log('Added encryption columns to Messages table');

    // Create GroupChatKeys table
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS GroupChatKeys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chatId UUID NOT NULL REFERENCES Chats(id) ON DELETE CASCADE,
        userId UUID NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
        encryptedGroupKey TEXT NOT NULL,
        keyVersion INTEGER DEFAULT 1,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chatId, userId, keyVersion)
      );
    `);

    console.log('Created GroupChatKeys table');

    console.log('Encryption migration completed successfully!');
  } catch (error) {
    console.error('Encryption migration failed:', error);
    throw error;
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateEncryption()
    .then(() => {
      console.log('Migration completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

module.exports = migrateEncryption;