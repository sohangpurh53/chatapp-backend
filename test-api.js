const axios = require('axios');

const API_BASE = 'http://localhost:3000/api';

async function testAPI() {
  try {
    console.log('🔍 Testing API endpoints...\n');

    // Test health endpoint
    console.log('1. Testing health endpoint...');
    const healthResponse = await axios.get(`${API_BASE}/health`);
    console.log('✅ Health check:', healthResponse.data);

    // Test registration
    console.log('\n2. Testing user registration...');
    const registerData = {
      username: 'testuser',
      email: 'test@example.com',
      password: 'password123'
    };

    try {
      const registerResponse = await axios.post(`${API_BASE}/auth/register`, registerData);
      console.log('✅ Registration successful:', registerResponse.data);
      
      // Test login with the same credentials
      console.log('\n3. Testing user login...');
      const loginResponse = await axios.post(`${API_BASE}/auth/login`, {
        email: registerData.email,
        password: registerData.password
      });
      console.log('✅ Login successful:', loginResponse.data);

    } catch (registerError) {
      if (registerError.response?.status === 400) {
        console.log('ℹ️  User already exists, testing login...');
        
        // Test login
        console.log('\n3. Testing user login...');
        const loginResponse = await axios.post(`${API_BASE}/auth/login`, {
          email: registerData.email,
          password: registerData.password
        });
        console.log('✅ Login successful:', loginResponse.data);
      } else {
        throw registerError;
      }
    }

    console.log('\n🎉 All tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    console.error('Full error:', error);
  }
}

// Run the test
testAPI();