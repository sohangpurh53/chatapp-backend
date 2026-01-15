/**
 * Debug script to check existing user's encryption key data
 */

const sequelize = require('./config/database');
const User = require('./models/User');

async function debugExistingUserKeys() {
  try {
    console.log('🔍 Debugging Existing User Keys\n');
    console.log('='.repeat(60));

    // Find an existing user
    const user = await User.findOne({
      where: {
        encryptionEnabled: true
      },
      attributes: ['id', 'username', 'keySalt', 'keyIv', 'encryptedPrivateKey', 'publicKey', 'keyVersion', 'keyCreatedAt']
    });

    if (!user) {
      console.log('No users with encryption found');
      process.exit(0);
    }

    console.log(`\nUser: ${user.username}`);
    console.log('-'.repeat(60));
    console.log(`ID: ${user.id}`);
    console.log(`Key Version: ${user.keyVersion}`);
    console.log(`Key Created: ${user.keyCreatedAt}`);
    console.log(`\nKey Data:`);
    console.log(`  keySalt length: ${user.keySalt?.length || 0}`);
    console.log(`  keySalt value: ${user.keySalt?.substring(0, 20)}...`);
    console.log(`  keyIv length: ${user.keyIv?.length || 0}`);
    console.log(`  keyIv value: ${user.keyIv?.substring(0, 20)}...`);
    console.log(`  keyIv === keySalt: ${user.keyIv === user.keySalt}`);
    console.log(`  encryptedPrivateKey length: ${user.encryptedPrivateKey?.length || 0}`);
    console.log(`  publicKey length: ${user.publicKey?.length || 0}`);

    // Check if keySalt and keyIv are base64
    console.log(`\nFormat Analysis:`);
    try {
      const saltDecoded = Buffer.from(user.keySalt, 'base64');
      console.log(`  keySalt is valid base64: YES (${saltDecoded.length} bytes)`);
    } catch (e) {
      console.log(`  keySalt is valid base64: NO`);
    }

    try {
      const ivDecoded = Buffer.from(user.keyIv, 'base64');
      console.log(`  keyIv is valid base64: YES (${ivDecoded.length} bytes)`);
    } catch (e) {
      console.log(`  keyIv is valid base64: NO`);
    }

    // Check if they're hex
    const hexRegex = /^[0-9a-fA-F]+$/;
    console.log(`  keySalt is hex: ${hexRegex.test(user.keySalt) ? 'YES' : 'NO'}`);
    console.log(`  keyIv is hex: ${hexRegex.test(user.keyIv) ? 'YES' : 'NO'}`);

    console.log('\n' + '='.repeat(60));
    console.log('\n💡 Analysis:');
    console.log('   If keyIv === keySalt, this is an existing user (backward compat)');
    console.log('   Both should be in base64 format');
    console.log('   The private key was encrypted using keySalt as the IV');
    console.log('   When decrypting, we need to use keyIv (which equals keySalt)');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

debugExistingUserKeys();
