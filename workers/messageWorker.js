const { Worker } = require('bullmq');
const redisService = require('../config/redis');
const { Message, User, MessageReceipt } = require('../models');
const notificationService = require('../services/notificationService');

// Socket.IO instance (will be set by server.js)
let io = null;

/**
 * Set Socket.IO instance for message delivery
 * Called by server.js after io is initialized
 */
function setIO(socketIO) {
  io = socketIO;
  console.log('✅ Message worker: Socket.IO instance set');
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
 * Emit message with acknowledgment
 */
function emitWithAck(socketId, event, data, timeout = 5000) {
  return new Promise((resolve) => {
    if (!io) {
      resolve(false);
      return;
    }

    let ackReceived = false;

    // Emit with acknowledgment callback
    io.to(socketId).emit(event, data, (ack) => {
      ackReceived = true;
      resolve(true);
    });

    // Timeout if no acknowledgment
    setTimeout(() => {
      if (!ackReceived) {
        resolve(false);
      }
    }, timeout);
  });
}

/**
 * Process message delivery job
 * Tries Socket.IO first, falls back to FCM if needed
 */
async function processMessageDelivery(job) {
  const { messageId, chatId, recipientIds } = job.data;

  console.log(`🔄 Processing message delivery job ${job.id} for message ${messageId}`);

  try {
    // Fetch complete message data
    const message = await Message.findByPk(messageId, {
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar', 'publicKey']
        },
        {
          model: User,
          as: 'receiver',
          attributes: ['id', 'username', 'avatar', 'publicKey'],
          required: false
        },
        {
          model: Message,
          as: 'replyTo',
          attributes: ['id', 'content', 'messageType', 'encryptedContent', 'isEncrypted', 'keyId'],
          include: [{
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'publicKey']
          }],
          required: false
        }
      ],
      attributes: {
        include: [
          'encryptedContent',
          'isEncrypted',
          'keyId',
          'encryptionIv',
          'authTag',
          'encryptionAlgorithm',
          'encryptionVersion'
        ]
      }
    });

    if (!message) {
      throw new Error(`Message ${messageId} not found`);
    }

    let deliveredCount = 0;
    let fcmNeededFor = [];

    // Try to deliver to each recipient
    for (const recipientId of recipientIds) {
      // Check if user is online
      const isOnline = await redisService.getUserOnlineStatus(recipientId);

      if (isOnline) {
        // Try Socket.IO delivery
        const socketId = await getSocketId(recipientId);

        if (socketId) {
          console.log(`📡 Attempting Socket.IO delivery to user ${recipientId}`);

          // Process encrypted content before emitting
          const messageToEmit = message.toJSON();
          if (messageToEmit.isEncrypted && messageToEmit.encryptedContent) {
            try {
              const encryptionService = require('../services/encryptionService');
              messageToEmit.encryptedContent = await encryptionService.processEncryptedContentForClient(
                messageToEmit.encryptedContent,
                messageToEmit.encryptionMetadata
              );
            } catch (error) {
              console.error('Failed to process encrypted content for worker delivery:', error);
              // Keep original content if processing fails
            }
          }

          const delivered = await emitWithAck(socketId, 'new_message', messageToEmit);

          if (delivered) {
            // Success! Mark as delivered via Socket.IO
            await MessageReceipt.update(
              {
                status: 'delivered',
                deliveryMethod: 'socket',
                deliveredAt: new Date()
              },
              {
                where: {
                  messageId,
                  userId: recipientId
                }
              }
            );

            deliveredCount++;
            console.log(`✅ Message ${messageId} delivered to user ${recipientId} via Socket.IO`);
            continue;
          } else {
            console.warn(`⚠️  Socket.IO delivery failed for user ${recipientId}, will use FCM`);
          }
        }
      }

      // Socket.IO failed or user offline - need FCM
      fcmNeededFor.push(recipientId);
    }

    // Send FCM notifications for users who didn't get Socket.IO delivery
    if (fcmNeededFor.length > 0) {
      console.log(`📱 Sending FCM notifications to ${fcmNeededFor.length} users`);

      for (const recipientId of fcmNeededFor) {
        try {
          await notificationService.notifyNewMessage({
            messageId: message.id,
            senderId: message.senderId,
            receiverId: recipientId,
            chatId: message.chatId,
            content: message.content,
            isEncrypted: message.isEncrypted,
            messageType: message.messageType
          });

          // Mark as pending (will be synced when user opens app)
          await MessageReceipt.update(
            {
              status: 'pending',
              deliveryMethod: 'fcm',
              fcmSentAt: new Date()
            },
            {
              where: {
                messageId,
                userId: recipientId
              }
            }
          );

          console.log(`✅ FCM notification sent for message ${messageId} to user ${recipientId}`);
        } catch (fcmError) {
          console.error(`❌ FCM failed for user ${recipientId}:`, fcmError.message);
          // Will retry the entire job
        }
      }
    }

    return {
      success: true,
      messageId,
      deliveredViaSocket: deliveredCount,
      deliveredViaFCM: fcmNeededFor.length,
      totalRecipients: recipientIds.length
    };

  } catch (error) {
    console.error(`❌ Message delivery job ${job.id} failed:`, error);
    throw error; // Will trigger retry
  }
}

// Create message worker
const messageWorker = new Worker(
  'messages',
  processMessageDelivery,
  {
    connection: redisService.client,
    concurrency: 50, // Process 50 jobs concurrently
    limiter: {
      max: 1000, // Max 1000 jobs
      duration: 1000 // per second
    }
  }
);

// Worker event handlers
messageWorker.on('completed', (job, result) => {
  console.log(`✅ Message worker completed job ${job.id}:`, result);
});

messageWorker.on('failed', async (job, err) => {
  console.error(`❌ Message worker failed job ${job?.id}:`, err.message);

  // Move to dead letter queue after all retries exhausted
  if (job && job.attemptsMade >= job.opts.attempts) {
    console.error(`💀 Moving job ${job.id} to dead letter queue after ${job.attemptsMade} attempts`);

    const { deadLetterQueue } = require('../config/queue');
    await deadLetterQueue.add('failed-message', {
      originalQueue: 'messages',
      originalJobId: job.id,
      originalData: job.data,
      error: err.message,
      attempts: job.attemptsMade,
      timestamp: new Date()
    });
  }
});

messageWorker.on('error', (err) => {
  console.error('❌ Message worker error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down message worker gracefully');
  await messageWorker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down message worker gracefully');
  await messageWorker.close();
  process.exit(0);
});

console.log('🚀 Message worker started');
console.log('📬 Listening for message delivery jobs...');
console.log('⚙️  Concurrency: 50 jobs, Rate limit: 1000 jobs/second');

module.exports = { messageWorker, setIO };
