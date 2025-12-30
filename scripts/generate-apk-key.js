const crypto = require('crypto');

/**
 * Generate a secure 64-bit encryption key for APK uploads
 * This script generates a cryptographically secure random key
 */

function generateSecureAPKKey() {
  // Generate 64 random bytes (512 bits) for extra security
  const key = crypto.randomBytes(64).toString('base64');
  
  console.log('🔐 Generated Secure APK Upload Key:');
  console.log('');
  console.log('Key:', key);
  console.log('');
  console.log('📋 Add this to your .env file:');
  console.log(`APK_UPLOAD_SECRET_KEY=${key}`);
  console.log('');
  console.log('📋 Add this to your upload script environment:');
  console.log(`APK_UPLOAD_KEY=${key}`);
  console.log('');
  console.log('⚠️  IMPORTANT: Keep this key secure and never commit it to version control!');
  console.log('');
  
  return key;
}

// Generate and display the key
generateSecureAPKKey();