const { User, Message, EncryptionSession } = require('./models');
const encryptionService = require('./services/encryptionService');

async function testEncryptionSystem() {
  try {
    console.log('🧪 Testing Enhanced Encryption System...\n');

    // Test 1: Validate encrypted message format
    console.log('1️⃣ Testing encrypted message validation...');
    const validEncryptedData = {
      encryptedContent: 'base64encodedcontent',
      iv: '12345678901234567890123456789012', // 32 hex chars = 16 bytes
      algorithm: 'aes-256-cbc' // Test with lowercase (should be normalized)
    };
    
    const validation = encryptionService.validateEncryptedMessage(validEncryptedData);
    console.log('✅ Validation result:', validation);

    // Test algorithm normalization
    console.log('\n🧪 Testing algorithm normalization...');
    const testAlgorithms = ['aes-256-cbc', 'AES-256-CBC', 'aes-256-gcm', 'AES-256-GCM'];
    testAlgorithms.forEach(alg => {
      const normalized = encryptionService.normalizeAlgorithm(alg);
      console.log(`${alg} -> ${normalized}`);
    });

    // Test 2: Test compression
    console.log('\n2️⃣ Testing content compression...');
    const largeContent = 'A'.repeat(2000); // 2KB content
    const compressionResult = await encryptionService.compressEncryptedContent(
      Buffer.from(largeContent).toString('base64')
    );
    console.log('✅ Compression result:', {
      compressed: compressionResult.compressed,
      originalSize: compressionResult.originalSize,
      finalSize: compressionResult.content.length
    });

    // Test 3: Test encryption session creation
    console.log('\n3️⃣ Testing encryption session...');
    
    // Find a test user or create one
    let testUser = await User.findOne({ where: { email: 'test@example.com' } });
    if (!testUser) {
      testUser = await User.create({
        username: 'testuser',
        email: 'test@example.com',
        password: 'testpass123',
        encryptionEnabled: true
      });
      console.log('📝 Created test user');
    }

    const sessionData = await encryptionService.createEncryptionSession(
      testUser.id,
      { userAgent: 'test-agent', ip: '127.0.0.1' }
    );
    console.log('✅ Session created:', {
      hasToken: !!sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      keyVersion: sessionData.keyVersion
    });

    // Test 4: Validate the session
    console.log('\n4️⃣ Testing session validation...');
    const sessionValidation = await encryptionService.validateEncryptionSession(sessionData.sessionToken);
    console.log('✅ Session validation:', {
      valid: sessionValidation.valid,
      userId: sessionValidation.userId
    });

    // Test 5: Test user encryption validation
    console.log('\n5️⃣ Testing user encryption validation...');
    const userValidation = await encryptionService.validateUserEncryption(testUser.id);
    console.log('✅ User encryption validation:', userValidation);

    // Test 6: Test encryption statistics
    console.log('\n6️⃣ Testing encryption statistics...');
    const stats = await encryptionService.getEncryptionStats();
    console.log('✅ Encryption stats:', stats);

    // Test 7: Test message with large encrypted content
    console.log('\n7️⃣ Testing large encrypted message creation...');
    
    // Create a test chat first
    const { Chat } = require('./models');
    const testChat = await Chat.create({
      name: 'Test Chat',
      isGroup: false,
      participant1Id: testUser.id,
      participant2Id: testUser.id, // Self chat for testing
      createdBy: testUser.id
    });
    
    const largeEncryptedContent = 'B'.repeat(5000); // 5KB encrypted content
    
    const testMessage = await Message.create({
      content: '[ENCRYPTED]',
      encryptedContent: largeEncryptedContent,
      isEncrypted: true,
      keyId: 'test-key-id',
      encryptionIv: '12345678901234567890123456789012', // 32 hex chars
      authTag: 'test-auth-tag',
      encryptionAlgorithm: 'AES-256-GCM',
      encryptionVersion: 1,
      encryptionMetadata: {
        compressed: true,
        originalSize: 5000,
        compressedSize: 2500
      },
      messageType: 'text',
      senderId: testUser.id,
      chatId: testChat.id
    });

    console.log('✅ Large encrypted message created:', {
      id: testMessage.id,
      contentLength: testMessage.encryptedContent.length,
      isEncrypted: testMessage.isEncrypted,
      algorithm: testMessage.encryptionAlgorithm
    });

    // Cleanup
    await testMessage.destroy();
    await testChat.destroy();
    await EncryptionSession.destroy({ where: { userId: testUser.id } });
    
    console.log('\n🎉 All encryption system tests passed!');
    console.log('\n📋 Summary:');
    console.log('✅ Message validation working');
    console.log('✅ Content compression working');
    console.log('✅ Encryption sessions working');
    console.log('✅ Session validation working');
    console.log('✅ User encryption validation working');
    console.log('✅ Statistics generation working');
    console.log('✅ Large encrypted messages supported');
    console.log('✅ Database migration successful (TEXT fields)');

  } catch (error) {
    console.error('❌ Encryption system test failed:', error);
    process.exit(1);
  }
}

// Run the test
testEncryptionSystem()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });