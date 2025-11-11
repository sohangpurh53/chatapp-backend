const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const { sequelize } = require('./models');
const { authenticateSocket } = require('./middleware/auth');
const SocketHandlers = require('./socket/socketHandlers');

// Import routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');

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

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Socket.IO authentication middleware (optional for development)
if (process.env.NODE_ENV === 'production') {
  io.use(authenticateSocket);
} else {
  // In development, make auth optional for testing
  io.use(async (socket, next) => {
    try {
      if (socket.handshake.auth.token) {
        await authenticateSocket(socket, next);
      } else {
        // Allow connection without auth for testing
        socket.userId = 'test-user';
        socket.user = { id: 'test-user', username: 'Test User' };
        next();
      }
    } catch (error) {
      // Allow connection even if auth fails in development
      socket.userId = 'test-user';
      socket.user = { id: 'test-user', username: 'Test User' };
      next();
    }
  });
}

// Initialize socket handlers
const socketHandlers = new SocketHandlers(io);

// Handle socket connections
io.on('connection', (socket) => {
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