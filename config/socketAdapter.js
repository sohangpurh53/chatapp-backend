const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
require('dotenv').config();

/**
 * Setup Socket.IO Redis Adapter for multi-server support
 * This allows multiple server instances to share Socket.IO state
 * 
 * @param {SocketIO.Server} io - Socket.IO server instance
 * @returns {Object} - { pubClient, subClient } Redis clients
 */
function setupSocketAdapter(io) {
  try {
    // Create Redis pub client
    const pubClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });

    // Create Redis sub client (duplicate of pub)
    const subClient = pubClient.duplicate();

    // Set up Socket.IO adapter
    io.adapter(createAdapter(pubClient, subClient));

    // Event handlers
    pubClient.on('connect', () => {
      console.log('✅ Socket.IO Redis Pub client connected');
    });

    subClient.on('connect', () => {
      console.log('✅ Socket.IO Redis Sub client connected');
    });

    pubClient.on('error', (err) => {
      console.error('❌ Socket.IO Redis Pub client error:', err.message);
    });

    subClient.on('error', (err) => {
      console.error('❌ Socket.IO Redis Sub client error:', err.message);
    });

    console.log('✅ Socket.IO Redis adapter configured successfully');
    console.log('📡 Multi-server mode enabled - servers can now share Socket.IO state');

    return { pubClient, subClient };
  } catch (error) {
    console.error('❌ Failed to setup Socket.IO Redis adapter:', error);
    console.warn('⚠️  Running in single-server mode (no Redis adapter)');
    return null;
  }
}

module.exports = { setupSocketAdapter };
