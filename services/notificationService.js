const { Notification, User } = require('../models');
const { notificationQueue } = require('../config/queue');

class NotificationService {
  /**
   * Create and queue notification for incoming call
   */
  async notifyIncomingCall(callData) {
    try {
      const { callId, callerId, receiverId, callType } = callData;

      // Get caller info
      const caller = await User.findByPk(callerId, {
        attributes: ['username', 'avatar']
      });

      if (!caller) {
        console.error(`Caller ${callerId} not found`);
        return null;
      }

      // Create notification record
      const notification = await Notification.create({
        userId: receiverId,
        type: 'incoming_call',
        title: `Incoming ${callType} call`,
        body: `${caller.username} is calling you`,
        data: {
          callId,
          callerId,
          callerName: caller.username,
          callerAvatar: caller.avatar,
          callType,
          action: 'open_call_screen'
        }
      });

      // Queue with HIGH priority
      await notificationQueue.add(
        'send-notification',
        {
          notificationId: notification.id,
          userId: receiverId,
          priority: 'high'
        },
        {
          priority: 1, // Highest priority
          delay: 0 // Send immediately
        }
      );

      console.log(`📞 Queued incoming call notification for user ${receiverId}`);
      return notification;
    } catch (error) {
      console.error('Notify incoming call error:', error);
      return null;
    }
  }

  /**
   * Create and queue notification for new message
   */
  async notifyNewMessage(messageData) {
    try {
      const { messageId, senderId, receiverId, chatId, content, isEncrypted, messageType } = messageData;

      // Get sender info
      const sender = await User.findByPk(senderId, {
        attributes: ['username', 'avatar']
      });

      if (!sender) {
        console.error(`Sender ${senderId} not found`);
        return null;
      }

      // Prepare message preview
      let messagePreview = content;
      if (isEncrypted) {
        messagePreview = '🔒 Encrypted message';
      } else if (messageType === 'image') {
        messagePreview = '📷 Photo';
      } else if (messageType === 'file') {
        messagePreview = '📎 File';
      } else if (messageType === 'audio') {
        messagePreview = '🎵 Audio';
      } else if (messageType === 'video') {
        messagePreview = '🎥 Video';
      }

      // Truncate long messages
      if (messagePreview && messagePreview.length > 100) {
        messagePreview = messagePreview.substring(0, 97) + '...';
      }

      // Create notification record
      const notification = await Notification.create({
        userId: receiverId,
        type: 'new_message',
        title: sender.username,
        body: messagePreview || 'New message',
        data: {
          messageId,
          senderId,
          senderName: sender.username,
          senderAvatar: sender.avatar,
          chatId,
          messageType,
          action: 'open_chat'
        }
      });

      // Queue with NORMAL priority
      await notificationQueue.add(
        'send-notification',
        {
          notificationId: notification.id,
          userId: receiverId,
          priority: 'normal'
        },
        {
          priority: 5, // Normal priority
          delay: 1000 // 1 second delay to batch messages
        }
      );

      console.log(`💬 Queued message notification for user ${receiverId}`);
      return notification;
    } catch (error) {
      console.error('Notify new message error:', error);
      return null;
    }
  }

  /**
   * Create and queue notification for missed call
   */
  async notifyMissedCall(callData) {
    try {
      const { callId, callerId, receiverId, callType } = callData;

      const caller = await User.findByPk(callerId, {
        attributes: ['username', 'avatar']
      });

      if (!caller) {
        console.error(`Caller ${callerId} not found`);
        return null;
      }

      const notification = await Notification.create({
        userId: receiverId,
        type: 'missed_call',
        title: 'Missed call',
        body: `You missed a ${callType} call from ${caller.username}`,
        data: {
          callId,
          callerId,
          callerName: caller.username,
          callerAvatar: caller.avatar,
          callType,
          action: 'open_call_history'
        }
      });

      await notificationQueue.add(
        'send-notification',
        {
          notificationId: notification.id,
          userId: receiverId,
          priority: 'normal'
        },
        {
          priority: 3
        }
      );

      console.log(`📵 Queued missed call notification for user ${receiverId}`);
      return notification;
    } catch (error) {
      console.error('Notify missed call error:', error);
      return null;
    }
  }

  /**
   * Notify group chat participants
   */
  async notifyGroupMessage(messageData, participantIds) {
    try {
      const { senderId } = messageData;

      // Filter out sender
      const recipients = participantIds.filter(id => id !== senderId);

      // Create notifications for all participants
      const notifications = await Promise.all(
        recipients.map(recipientId =>
          this.notifyNewMessage({ ...messageData, receiverId: recipientId })
        )
      );

      const successCount = notifications.filter(n => n !== null).length;
      console.log(`👥 Queued ${successCount}/${recipients.length} group message notifications`);
      return notifications;
    } catch (error) {
      console.error('Notify group message error:', error);
      return [];
    }
  }
}

module.exports = new NotificationService();
