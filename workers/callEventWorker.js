const { Worker } = require('bullmq');
const redisService = require('../config/redis');
const { Call, User } = require('../models');
const notificationService = require('../services/notificationService');

// Socket.IO instance (will be set by server.js)
let io = null;

/**
 * Set Socket.IO instance for call event delivery
 * Called by server.js after io is initialized
 */
function setIO(socketIO) {
  io = socketIO;
  console.log('✅ Call event worker: Socket.IO instance set');
}

/**
 * Get socket ID for a user
 */
async function getSocketId(userId) {
  try {
    const socketId = await redisService.client.get(`online:${userId}`);
    return socketId;
  } catch (error) {
    console.error(`Error getting socket ID for user ${userId}:`, error);
    return null;
  }
}

/**
 * Process call event job
 * Tries Socket.IO first, falls back to FCM if needed
 */
async function processCallEvent(job) {
  const { eventType, callId, targetUserId, callData } = job.data;

  console.log(`🔄 Processing call event job ${job.id}: ${eventType} for call ${callId}`);

  try {
    if (!io) {
      throw new Error('Socket.IO not initialized');
    }

    // Check if target user is online
    const isOnline = await redisService.getUserOnlineStatus(targetUserId);

    if (isOnline) {
      // Try Socket.IO delivery
      const socketId = await getSocketId(targetUserId);

      if (socketId) {
        console.log(`📡 Attempting Socket.IO delivery of ${eventType} to user ${targetUserId}`);

        // Emit call event
        io.to(socketId).emit(eventType, callData);

        console.log(`✅ Call event ${eventType} delivered to user ${targetUserId} via Socket.IO`);

        return {
          success: true,
          eventType,
          targetUserId,
          deliveryMethod: 'socket',
          deliveredAt: new Date()
        };
      }
    }

    // Socket.IO failed or user offline - use FCM
    console.log(`📱 User ${targetUserId} offline or Socket.IO failed, sending FCM notification`);

    // Send FCM notification based on event type
    if (eventType === 'incoming-call') {
      await notificationService.notifyIncomingCall({
        callId,
        callerId: callData.from || callData.callerId,
        receiverId: targetUserId,
        callType: callData.callType
      });

      console.log(`✅ FCM call notification sent to user ${targetUserId}`);

      return {
        success: true,
        eventType,
        targetUserId,
        deliveryMethod: 'fcm',
        deliveredAt: new Date()
      };
    } else {
      // For other call events, just log (they're not critical for FCM)
      console.log(`ℹ️  Call event ${eventType} not sent via FCM (user offline)`);

      return {
        success: true,
        eventType,
        targetUserId,
        deliveryMethod: 'skipped',
        reason: 'user_offline'
      };
    }

  } catch (error) {
    console.error(`❌ Call event job ${job.id} failed:`, error);
    throw error; // Will trigger retry
  }
}

// Create call event worker
const callEventWorker = new Worker(
  'call-events',
  processCallEvent,
  {
    connection: redisService.client,
    concurrency: 20, // Process 20 jobs concurrently
    limiter: {
      max: 500, // Max 500 jobs
      duration: 1000 // per second
    }
  }
);

// Worker event handlers
callEventWorker.on('completed', (job, result) => {
  console.log(`✅ Call event worker completed job ${job.id}:`, result);
});

callEventWorker.on('failed', async (job, err) => {
  console.error(`❌ Call event worker failed job ${job?.id}:`, err.message);

  // Move to dead letter queue after all retries exhausted
  if (job && job.attemptsMade >= job.opts.attempts) {
    console.error(`💀 Moving job ${job.id} to dead letter queue after ${job.attemptsMade} attempts`);

    const { deadLetterQueue } = require('../config/queue');
    await deadLetterQueue.add('failed-call-event', {
      originalQueue: 'call-events',
      originalJobId: job.id,
      originalData: job.data,
      error: err.message,
      attempts: job.attemptsMade,
      timestamp: new Date()
    });
  }
});

callEventWorker.on('error', (err) => {
  console.error('❌ Call event worker error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down call event worker gracefully');
  await callEventWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down call event worker gracefully');
  await callEventWorker.close();
  process.exit(0);
});

console.log('🚀 Call event worker started');
console.log('📬 Listening for call event jobs...');
console.log('⚙️  Concurrency: 20 jobs, Rate limit: 500 jobs/second');

module.exports = { callEventWorker, setIO };
