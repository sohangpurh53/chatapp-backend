const { Worker } = require('bullmq');
const redisService = require('../config/redis');
const fcmService = require('../services/fcmService');
const { Notification } = require('../models');

// Create worker to process notification jobs
const notificationWorker = new Worker(
  'notifications',
  async (job) => {
    const { notificationId, userId, priority } = job.data;

    console.log(`🔄 Processing notification job ${job.id} for user ${userId} (priority: ${priority})`);

    try {
      // Fetch notification from database
      const notification = await Notification.findByPk(notificationId);

      if (!notification) {
        throw new Error(`Notification ${notificationId} not found`);
      }

      // Send via FCM
      const result = await fcmService.sendNotification(userId, notification);

      return {
        success: true,
        notificationId,
        userId,
        messageId: result.messageId,
        reason: result.reason
      };

    } catch (error) {
      console.error(`❌ Notification job ${job.id} failed:`, error);
      throw error; // Will trigger retry
    }
  },
  {
    connection: redisService.client,
    concurrency: 10, // Process 10 jobs concurrently
    limiter: {
      max: 100, // Max 100 jobs
      duration: 1000 // per second
    }
  }
);

// Worker event handlers
notificationWorker.on('completed', (job, result) => {
  console.log(`✅ Worker completed job ${job.id}:`, result);
});

notificationWorker.on('failed', (job, err) => {
  console.error(`❌ Worker failed job ${job?.id}:`, err.message);
});

notificationWorker.on('error', (err) => {
  console.error('❌ Worker error:', err);
});

console.log('🚀 Notification worker started');
console.log('📬 Listening for notification jobs...');

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down worker gracefully');
  await notificationWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down worker gracefully');
  await notificationWorker.close();
  process.exit(0);
});

module.exports = notificationWorker;
