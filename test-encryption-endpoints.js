/**
 * Test script for encrypted chat endpoints
 * Run with: node test-encryption-endpoints.js
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

// Test data
let authToken = '';
let userId = '';
let testUser2Token = '';
let testUser2Id = '';
let chatId = '';

// Sample encryption keys (for testing only - in production these are generated client-side)
const sampleKeys = {
  publicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...\n-----END PUBLIC KEY-----',
  encryptedPrivateKey: 'base64_encrypted_private_key_data_here',
  keySalt: 'base64_salt_data_here'
};

async function testRegisterWithKeys() {
  console.log('\n=== Test 1: Register User with Encryption Keys ===');
  try {
    const response = await axios.post(`${BASE_URL}/auth/register`, {
      username: `testuser_${Date.now()}`,
      email: `test_${Date.now()}@example.com`,
      password: 'password123',
      publicKey: sampleKeys.publicKey,
      encryptedPrivateKey: sampleKeys.encryptedPrivateKey,
      keySalt: sampleKeys.keySalt
    });
    
    authToken = response.data.token;
    userId = response.data.user.id;
    
    console.log('✅ Registration successful');
    console.log('User ID:', userId);
    console.log('Has public key:', !!response.data.user.publicKey);
    return true;
  } catch (error) {
    console.error('❌ Registration failed:', error.response?.data || error.message);
    return false;
  }
}

async function testRegisterSecondUser() {
  console.log('\n=== Test 2: Register Second User ===');
  try {
    const response = await axios.post(`${BASE_URL}/auth/register`, {
      username: `testuser2_${Date.now()}`,
      email: `test2_${Date.now()}@example.com`,
      password: 'password123',
      publicKey: sampleKeys.publicKey + '_user2',
      encryptedPrivateKey: sampleKeys.encryptedPrivateKey + '_user2',
      keySalt: sampleKeys.keySalt + '_user2'
    });
    
    testUser2Token = response.data.token;
    testUser2Id = response.data.user.id;
    
    console.log('✅ Second user registration successful');
    console.log('User 2 ID:', testUser2Id);
    return true;
  } catch (error) {
    console.error('❌ Second user registration failed:', error.response?.data || error.message);
    return false;
  }
}

async function testUploadKeys() {
  console.log('\n=== Test 3: Upload/Update Encryption Keys ===');
  try {
    const response = await axios.post(
      `${BASE_URL}/auth/keys`,
      {
        publicKey: sampleKeys.publicKey + '_updated',
        encryptedPrivateKey: sampleKeys.encryptedPrivateKey + '_updated',
        keySalt: sampleKeys.keySalt + '_updated'
      },
      {
        headers: { Authorization: `Bearer ${authToken}` }
      }
    );
    
    console.log('✅ Keys uploaded successfully');
    console.log('Response:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Upload keys failed:', error.response?.data || error.message);
    return false;
  }
}

async function testGetEncryptedPrivateKey() {
  console.log('\n=== Test 4: Get Encrypted Private Key ===');
  try {
    const response = await axios.get(
      `${BASE_URL}/auth/keys`,
      {
        headers: { Authorization: `Bearer ${authToken}` }
      }
    );
    
    console.log('✅ Retrieved encrypted private key');
    console.log('Has encrypted private key:', !!response.data.encryptedPrivateKey);
    console.log('Has key salt:', !!response.data.keySalt);
    console.log('Key version:', response.data.keyVersion);
    return true;
  } catch (error) {
    console.error('❌ Get encrypted private key failed:', error.response?.data || error.message);
    return false;
  }
}

async function testGetUserPublicKey() {
  console.log('\n=== Test 5: Get User Public Key ===');
  try {
    const response = await axios.get(
      `${BASE_URL}/auth/users/${testUser2Id}/public-key`,
      {
        headers: { Authorization: `Bearer ${authToken}` }
      }
    );
    
    console.log('✅ Retrieved user public key');
    console.log('User ID:', response.data.userId);
    console.log('Username:', response.data.username);
    console.log('Has public key:', !!response.data.publicKey);
    return true;
  } catch (error) {
    console.error('❌ Get user public key failed:', error.response?.data || error.message);
    return false;
  }
}

async function testCreateGroupWithKeys() {
  console.log('\n=== Test 6: Create Group Chat with Encrypted Keys ===');
  try {
    const response = await axios.post(
      `${BASE_URL}/chat/create-group-with-keys`,
      {
        name: 'Test Encrypted Group',
        description: 'Testing group encryption',
        participantIds: [userId, testUser2Id],
        encryptedGroupKeys: [
          {
            userId: userId,
            encryptedKey: 'encrypted_group_key_for_user1',
            keyVersion: 1
          },
          {
            userId: testUser2Id,
            encryptedKey: 'encrypted_group_key_for_user2',
            keyVersion: 1
          }
        ]
      },
      {
        headers: { Authorization: `Bearer ${authToken}` }
      }
    );
    
    chatId = response.data.chat.id;
    
    console.log('✅ Group created with encrypted keys');
    console.log('Chat ID:', chatId);
    console.log('Group name:', response.data.chat.name);
    console.log('Participants:', response.data.chat.participants?.length);
    return true;
  } catch (error) {
    console.error('❌ Create group with keys failed:', error.response?.data || error.message);
    return false;
  }
}

async function testGetGroupKey() {
  console.log('\n=== Test 7: Get Encrypted Group Key ===');
  try {
    const response = await axios.get(
      `${BASE_URL}/chat/${chatId}/group-key`,
      {
        headers: { Authorization: `Bearer ${authToken}` }
      }
    );
    
    console.log('✅ Retrieved encrypted group key');
    console.log('Has encrypted group key:', !!response.data.encryptedGroupKey);
    console.log('Key version:', response.data.keyVersion);
    return true;
  } catch (error) {
    console.error('❌ Get group key failed:', error.response?.data || error.message);
    return false;
  }
}

async function testSearchUsers() {
  console.log('\n=== Test 8: Search Users ===');
  try {
    const response = await axios.get(
      `${BASE_URL}/chat/search/users?query=testuser`,
      {
        headers: { Authorization: `Bearer ${authToken}` }
      }
    );
    
    console.log('✅ User search successful');
    console.log('Found users:', response.data.users?.length);
    return true;
  } catch (error) {
    console.error('❌ Search users failed:', error.response?.data || error.message);
    return false;
  }
}

async function runAllTests() {
  console.log('🚀 Starting Encrypted Chat Endpoint Tests...\n');
  console.log('Make sure your backend server is running on http://localhost:3000\n');
  
  const tests = [
    testRegisterWithKeys,
    testRegisterSecondUser,
    testUploadKeys,
    testGetEncryptedPrivateKey,
    testGetUserPublicKey,
    testCreateGroupWithKeys,
    testGetGroupKey,
    testSearchUsers
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    const result = await test();
    if (result) {
      passed++;
    } else {
      failed++;
    }
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Results:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Total: ${tests.length}`);
  console.log('='.repeat(50));
  
  if (failed === 0) {
    console.log('\n🎉 All tests passed! Your encrypted chat backend is ready!');
  } else {
    console.log('\n⚠️  Some tests failed. Please check the errors above.');
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
