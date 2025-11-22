const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const { sequelize } = require('./models');
const { authenticateSocket } = require('./middleware/auth');
const SocketHandlers = require('./socket/socketHandlers');
const redisService = require('./config/redis');

// Import routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const callRoutes = require('./routes/calls');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files for testing
app.use(express.static('public'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/calls', callRoutes);

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
    console.log(`[SOCKET AUTH] User ${socket.user.username} (${socket.userId}) authenticated`);
  } catch (error) {
    console.error('[SOCKET AUTH] Authentication failed:', error.message);
    next(new Error('Authentication failed'));
  }
});

// Initialize socket handlers
const socketHandlers = new SocketHandlers(io);

// Handle socket connections
io.on('connection', (socket) => {
  console.log('[SOCKET CONNECT] New connection handshake.auth =', socket.handshake.auth);
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

    // Start server
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
      console.log(`📡 Socket.IO server ready`);
      console.log(`🔗 API Base URL: http://localhost:${PORT}/api`);
      console.log(`🧪 Socket Test Page: http://localhost:${PORT}/socket-test.html`);
      console.log(`❤️  Health Check: http://localhost:${PORT}/api/health`);
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