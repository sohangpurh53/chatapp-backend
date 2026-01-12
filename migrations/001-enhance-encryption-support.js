'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Fix the VARCHAR(255) issue by ensuring all text fields use TEXT type
    await queryInterface.changeColumn('Messages', 'content', {
      type: Sequelize.TEXT,
      allowNull: true
    });

    // Ensure encrypted content can handle large payloads
    await queryInterface.changeColumn('Messages', 'encryptedContent', {
      type: Sequelize.TEXT,
      allowNull: true
    });

    // Add encryption metadata fields if they don't exist
    try {
      await queryInterface.addColumn('Messages', 'encryptionMetadata', {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Additional encryption metadata (algorithm, version, etc.)'
      });
    } catch (error) {
      console.log('encryptionMetadata column already exists');
    }

    // Add missing User encryption fields
    try {
      await queryInterface.addColumn('Users', 'encryptionEnabled', {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
        comment: 'Whether user has encryption enabled'
      });
    } catch (error) {
      console.log('encryptionEnabled column already exists');
    }

    try {
      await queryInterface.addColumn('Users', 'keyDerivationRounds', {
        type: Sequelize.INTEGER,
        defaultValue: 100000,
        comment: 'PBKDF2 rounds for key derivation'
      });
    } catch (error) {
      console.log('keyDerivationRounds column already exists');
    }

    // Add key rotation tracking
    try {
      await queryInterface.addColumn('Users', 'keyRotationHistory', {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'History of key rotations for audit purposes'
      });
    } catch (error) {
      console.log('keyRotationHistory column already exists');
    }

    // Add encryption session tracking
    try {
      await queryInterface.createTable('EncryptionSessions', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true
        },
        userId: {
          type: Sequelize.UUID,
          allowNull: false,
          references: {
            model: 'Users',
            key: 'id'
          },
          onDelete: 'CASCADE'
        },
        sessionToken: {
          type: Sequelize.STRING,
          allowNull: false,
          unique: true
        },
        keyVersion: {
          type: Sequelize.INTEGER,
          defaultValue: 1
        },
        expiresAt: {
          type: Sequelize.DATE,
          allowNull: false
        },
        deviceInfo: {
          type: Sequelize.JSON,
          allowNull: true
        },
        isActive: {
          type: Sequelize.BOOLEAN,
          defaultValue: true
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false
        }
      });
    } catch (error) {
      console.log('EncryptionSessions table already exists');
    }

    // Add indexes for better performance
    try {
      await queryInterface.addIndex('Messages', ['isEncrypted', 'chatId']);
      await queryInterface.addIndex('Messages', ['keyId']);
      await queryInterface.addIndex('GroupChatKeys', ['chatId', 'keyVersion']);
      await queryInterface.addIndex('Users', ['publicKey']);
    } catch (error) {
      console.log('Some indexes already exist');
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Revert changes if needed
    await queryInterface.removeColumn('Messages', 'encryptionMetadata');
    await queryInterface.removeColumn('Users', 'keyRotationHistory');
    await queryInterface.dropTable('EncryptionSessions');
  }
};