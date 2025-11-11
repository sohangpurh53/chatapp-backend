const { io } = require('socket.io-client');

async function testSocketConnection() {
  console.log('🔌 Testing Socket.IO connection...\n');

  // Test 1: Connection without authentication (development mode)
  console.log('1. Testing connection without auth...');
  const socket1 = io('http://localhost:3000', {
    transports: ['websocket', 'polling']
  });

  socket1.on('connect', () => {
    console.log('✅ Connected without auth! Socket ID:', socket1.id);
    
    // Test basic events
    socket1.emit('join_chat', { chatId: 'test-chat-123' });
    console.log('📤 Sent join_chat event');
    
    socket1.disconnect();
    console.log('🔌 Disconnected\n');
    
    // Test 2: Connection with authentication
    testWithAuth();
  });

  socket1.on('connect_error', (error) => {
    console.error('❌ Connection failed without auth:', error.message);
    console.log('🔄 Trying with authentication...\n');
    socket1.disconnect();
    testWithAuth();
  });

  socket1.on('user_joined', (data) => {
    console.log('📥 Received user_joined:', data);
  });

  socket1.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });
}

async function testWithAuth() {
  console.log('2. Testing connection with authentication...');
  
  // First, get a token by registering/logging in
  const axios = require('axios');
  
  try {
    let token;
    
    // Try to login first
    try {
      const loginResponse = await axios.post('http://localhost:3000/api/auth/login', {
        email: 'test@example.com',
        password: 'password123'
      });
      token = loginResponse.data.token;
      console.log('✅ Logged in successfully');
    } catch (loginError) {
      // If login fails, try to register
      console.log('ℹ️  Login failed, trying registration...');
      const registerResponse = await axios.post('http://localhost:3000/api/auth/register', {
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      });
      token = registerResponse.data.token;
      console.log('✅ Registered successfully');
    }

    // Now test socket connection with token
    const socket2 = io('http://localhost:3000', {
      auth: {
        token: token
      },
      transports: ['websocket', 'polling']
    });

    socket2.on('connect', () => {
      console.log('✅ Connected with auth! Socket ID:', socket2.id);
      
      // Test authenticated events
      socket2.emit('join_chat', { chatId: 'authenticated-chat-123' });
      console.log('📤 Sent authenticated join_chat event');
      
      setTimeout(() => {
        socket2.disconnect();
        console.log('🔌 Disconnected authenticated socket');
        console.log('\n🎉 All socket tests completed!');
        process.exit(0);
      }, 2000);
    });

    socket2.on('connect_error', (error) => {
      console.error('❌ Authenticated connection failed:', error.message);
      process.exit(1);
    });

    socket2.on('user_joined', (data) => {
      console.log('📥 Received authenticated user_joined:', data);
    });

  } catch (error) {
    console.error('❌ Authentication failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

// Add some debugging for Socket.IO
process.env.DEBUG = 'socket.io:client';

// Run the test
testSocketConnection();