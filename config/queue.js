const { Queue, QueueEvents } = require('bullmq');
const redisService = require('./redis');

// Create notification queue with priority support
const notificationQueue = new Queue('notifications', {
  connection: redisService.client,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: {
      age: 86400, // Keep completed jobs for 24 hours
      count: 1000
    },
    removeOnFail: {
      age: 604800 // Keep failed jobs for 7 days
    }
  }
});

// Queue events for monitoring
const queueEvents = new QueueEvents('notifications', {
  connection: redisService.client
});

queueEvents.on('completed', ({ jobId }) => {
  console.log(`✅ Notification job ${jobId} completed`);
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`❌ Notification job ${jobId} failed:`, failedReason);
});

queueEvents.on('error', (error) => {
  console.error('❌ Queue events error:', error);
});

console.log('📬 Notification queue initialized');

module.exports = { notificationQueue, queueEvents };
