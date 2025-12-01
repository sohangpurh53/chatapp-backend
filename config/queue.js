const { Queue, QueueEvents } = require('bullmq');
const redisService = require('./redis');

// ============================================================================
// EXISTING: Notification Queue (UNCHANGED - Keep working as-is)
// ============================================================================
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

// ============================================================================
// NEW: Message Queue for guaranteed message delivery
// ============================================================================
const messageQueue = new Queue('messages', {
  connection: redisService.client,
  defaultJobOptions: {
    attempts: 10, // Retry up to 10 times for guaranteed delivery
    backoff: {
      type: 'exponential',
      delay: 1000 // 1s, 2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s
    },
    removeOnComplete: {
      age: 86400, // Keep completed jobs for 24 hours
      count: 10000 // Keep more message jobs for audit
    },
    removeOnFail: false // Keep all failed jobs for investigation
  }
});

// Message queue events
const messageQueueEvents = new QueueEvents('messages', {
  connection: redisService.client
});

messageQueueEvents.on('completed', ({ jobId }) => {
  console.log(`✅ Message delivery job ${jobId} completed`);
});

messageQueueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`❌ Message delivery job ${jobId} failed:`, failedReason);
});

messageQueueEvents.on('error', (error) => {
  console.error('❌ Message queue events error:', error);
});

console.log('📬 Message queue initialized');

// ============================================================================
// NEW: Call Event Queue for guaranteed call notifications
// ============================================================================
const callEventQueue = new Queue('call-events', {
  connection: redisService.client,
  defaultJobOptions: {
    attempts: 5, // Retry up to 5 times
    backoff: {
      type: 'fixed',
      delay: 500 // Fixed 500ms delay between retries (calls are time-sensitive)
    },
    removeOnComplete: {
      age: 3600, // Keep completed jobs for 1 hour
      count: 1000
    },
    removeOnFail: false // Keep all failed jobs
  }
});

// Call event queue events
const callQueueEvents = new QueueEvents('call-events', {
  connection: redisService.client
});

callQueueEvents.on('completed', ({ jobId }) => {
  console.log(`✅ Call event job ${jobId} completed`);
});

callQueueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`❌ Call event job ${jobId} failed:`, failedReason);
});

callQueueEvents.on('error', (error) => {
  console.error('❌ Call event queue error:', error);
});

console.log('📬 Call event queue initialized');

// ============================================================================
// NEW: Dead Letter Queue for permanently failed jobs
// ============================================================================
const deadLetterQueue = new Queue('dead-letter', {
  connection: redisService.client,
  defaultJobOptions: {
    removeOnComplete: false, // Keep all completed
    removeOnFail: false // Keep all failed
  }
});

// Dead letter queue events
const deadLetterQueueEvents = new QueueEvents('dead-letter', {
  connection: redisService.client
});

deadLetterQueueEvents.on('completed', ({ jobId }) => {
  console.log(`⚠️  Dead letter job ${jobId} logged`);
});

console.log('📬 Dead letter queue initialized');

// ============================================================================
// Export all queues
// ============================================================================
module.exports = {
  // Existing (unchanged)
  notificationQueue,
  queueEvents,
  
  // New queues
  messageQueue,
  messageQueueEvents,
  callEventQueue,
  callQueueEvents,
  deadLetterQueue,
  deadLetterQueueEvents
};
