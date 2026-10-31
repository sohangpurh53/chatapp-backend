const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const { sequelize } = require('./models');
const { authenticateSocket } = require('./middleware/auth');
const SocketHandlers = require('./socket/socketHandlers');
const redisService = require('./config/redis');

// Bull Board for queue monitoring
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { 
  notificationQueue, 
  messageQueue, 
  callEventQueue, 
  deadLetterQueue 
} = require('./config/queue');

// Socket.IO Redis Adapter for multi-server support
const { setupSocketAdapter } = require('./config/socketAdapter');
const { requireAdmin } = require('./middleware/adminAuth');

// Import routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const callRoutes = require('./routes/calls');
const notificationRoutes = require('./routes/notifications');
const mediaRoutes = require('./routes/media');
const appLogsRoutes = require("./routes/applogs")
const apkRoutes = require('./routes/apk');
const aiRoutes = require('./routes/ai');
const gameRoutes = require('./routes/games');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  // A phone that lost its connection is noticed within 25 s (default: 45 s)
  pingInterval: 15000,
  pingTimeout: 10000
});

// Setup Redis adapter for multi-server Socket.IO support
// This allows multiple server instances to share Socket.IO state
setupSocketAdapter(io);

// Controllers push real-time group updates through this
app.set('io', io);
require('./services/sessionService').setIO(io);
require('./services/games').setIO(io);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files for testing
app.use(express.static('public'));

// Setup Bull Board Dashboard with all queues
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullMQAdapter(notificationQueue),
    new BullMQAdapter(messageQueue),
    new BullMQAdapter(callEventQueue),
    new BullMQAdapter(deadLetterQueue)
  ],
  serverAdapter: serverAdapter,
});

app.use('/admin/queues', requireAdmin, serverAdapter.getRouter());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/media', mediaRoutes);
app.use("/api", appLogsRoutes);
app.use('/api/apk', apkRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/games', gameRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Socket.IO authentication middleware
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      console.error('[SOCKET AUTH] No token provided');
      return next(new Error('Authentication token required'));
    }
    
    // Use the authenticateSocket middleware
    await authenticateSocket(socket, next);
    // authenticateSocket already called next(err) when it rejected the socket
    if (socket.user) console.log(`[SOCKET AUTH] User ${socket.user.username} (${socket.userId}) authenticated`);
  } catch (error) {
    console.error('[SOCKET AUTH] Authentication failed:', error.message);
    next(new Error('Authentication failed'));
  }
});

// Initialize socket handlers
const socketHandlers = new SocketHandlers(io);

// Handle socket connections
io.on('connection', (socket) => {
  console.log('[SOCKET CONNECT] Socket id:', socket.id, 'assigned userId:', socket.userId);
  socketHandlers.handleConnection(socket);
});

// Database connection and server start
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('Database connection established successfully.');

    // Sync database models
    await sequelize.sync({ alter: true });
    console.log('Database models synchronized.');

    // Users marked online before a restart/crash have no socket any more
    await socketHandlers.resetOnlineStatuses();

    // Game sessions whose timer was lost in a restart move on from here
    require('./services/games').startSweeper();

    // Initialize MinIO bucket
    const { initializeBucket } = require('./config/minio');
    await initializeBucket();

    // Initialize workers with Socket.IO instance
    console.log('🚀 Initializing workers...');
    
    // Import and set up message worker
    const { messageWorker, setIO: setMessageWorkerIO } = require('./workers/messageWorker');
    setMessageWorkerIO(io);
    console.log('✅ Message worker initialized');
    
    // Import and set up call event worker
    const { callEventWorker, setIO: setCallEventWorkerIO } = require('./workers/callEventWorker');
    setCallEventWorkerIO(io);
    console.log('✅ Call event worker initialized');
    
    // Start notification worker in production
    if (process.env.NODE_ENV === 'production') {
      console.log('🚀 Starting notification worker in production mode...');
      require('./workers/notificationWorker');
    } else {
      console.log('ℹ️  Notification worker not started (development mode)');
      console.log('ℹ️  To start workers manually:');
      console.log('   - npm run start:worker (notifications)');
      console.log('   - npm run start:message-worker (messages)');
      console.log('   - npm run start:call-worker (calls)');
      console.log('   - npm run start:all-workers (all workers)');
    }

    // Start server
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
      console.log(`📡 Socket.IO server ready`);
      console.log(`🔗 API Base URL: http://localhost:${PORT}/api`);
      console.log(`🧪 Socket Test Page: http://localhost:${PORT}/socket-test.html`);
      console.log(`❤️  Health Check: http://localhost:${PORT}/api/health`);
      console.log(`📬 Notifications: http://localhost:${PORT}/api/notifications`);
      console.log(`📊 Queue Dashboard: http://localhost:${PORT}/admin/queues`);
      console.log(`📁 Media Upload: http://localhost:${PORT}/api/media/upload`);
      console.log(`🏥 MinIO Health: http://localhost:${PORT}/api/media/health`);
      console.log(`📱 APK Upload: http://localhost:${PORT}/api/apk/upload`);
      console.log(`🔐 APK Service Health: http://localhost:${PORT}/api/apk/health`);
    });
  } catch (error) {
    console.error('Unable to start server:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await sequelize.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, io };