'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Messages', 'senderEncryptedKey', {
      type: Sequelize.TEXT,
      allowNull: true,
      defaultValue: null,
      comment: 'AES key encrypted with sender\'s public key (for sender to decrypt their own messages)'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Messages', 'senderEncryptedKey');
  }
};