const { Notification, User, Chat, Message } = require('../models');
const { notificationQueue } = require('../config/queue');

class NotificationService {
  /**
   * Create and queue notification for incoming call
   */
  async notifyIncomingCall(callData) {
    try {
      const { callId, callerId, receiverId, callType, chatId } = callData;

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
          receiverId, // Added for frontend to identify receiver
          callerName: caller.username,
          callerAvatar: caller.avatar,
          callType,
          chatId, // Added for group calls
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
   * ✅ ENHANCED: Include complete chat data in FCM notification
   */
  async notifyNewMessage(messageData) {
    try {
      const { messageId, senderId, receiverId, chatId, content, isEncrypted, messageType, _completeChatData } = messageData;

      // Get sender info
      const sender = await User.findByPk(senderId, {
        attributes: ['username', 'avatar']
      });

      if (!sender) {
        console.error(`Sender ${senderId} not found`);
        return null;
      }

      // ✅ Use pre-fetched chat data if available (for group messages), otherwise fetch it
      let completeChat = _completeChatData;
      
      if (!completeChat) {
        // ✅ FETCH COMPLETE CHAT DATA with all associations
        completeChat = await Chat.findByPk(chatId, {
          include: [
            {
              model: Message,
              as: 'messages',
              limit: 1, // Only get the latest message (the one being sent)
              order: [['createdAt', 'DESC']],
              include: [
                {
                  model: User,
                  as: 'sender',
                  attributes: ['id', 'username', 'avatar', 'publicKey']
                },
                {
                  model: User,
                  as: 'receiver',
                  attributes: ['id', 'username', 'avatar', 'publicKey']
                },
                {
                  model: Message,
                  as: 'replyTo',
                  include: [
                    {
                      model: User,
                      as: 'sender',
                      attributes: ['id', 'username', 'avatar']
                    }
                  ]
                }
              ]
            },
            {
              model: User,
              as: 'participant1',
              attributes: ['id', 'username', 'avatar', 'isOnline']
            },
            {
              model: User,
              as: 'participant2',
              attributes: ['id', 'username', 'avatar', 'isOnline']
            },
            {
              model: User,
              as: 'participants',
              attributes: ['id', 'username', 'avatar', 'isOnline'],
              through: {
                attributes: ['role', 'joinedAt']
              }
            }
          ]
        });
      }

      if (!completeChat) {
        console.error(`Chat ${chatId} not found`);
        return null;
      }

      // Prepare message preview for notification title/body
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

      // Truncate long messages for preview
      if (messagePreview && messagePreview.length > 100) {
        messagePreview = messagePreview.substring(0, 97) + '...';
      }

      // Create notification record
      const notification = await Notification.create({
        userId: receiverId,
        type: 'new_message',
        title: completeChat.isGroup ? completeChat.name || 'Group Chat' : sender.username,
        body: completeChat.isGroup ? `${sender.username}: ${messagePreview || 'New message'}` : (messagePreview || 'New message'),
        data: {
          // ✅ LIGHTWEIGHT FCM DATA: Only essential info for FCM (under 4KB limit)
          messageId,
          senderId,
          senderName: sender.username,
          senderAvatar: sender.avatar,
          chatId,
          messageType,
          messagePreview,
          action: 'open_chat',
          
          // Essential chat information only
          chatType: completeChat.isGroup ? 'group' : 'direct',
          chatName: completeChat.name || (completeChat.isGroup ? 'Group Chat' : sender.username),
          chatAvatar: completeChat.avatar,
          isGroup: completeChat.isGroup ? 'true' : 'false',
          timestamp: new Date().toISOString(),
          
          // ✅ SIGNAL: Client should fetch full chat data via API/socket
          needsFullChatData: 'true'
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

      console.log(`💬 Queued message notification with complete chat data for user ${receiverId}`);
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
   * ✅ ENHANCED: Include complete chat data for group notifications
   */
  async notifyGroupMessage(messageData, participantIds) {
    try {
      const { senderId, chatId } = messageData;

      // Filter out sender
      const recipients = participantIds.filter(id => id !== senderId);

      // ✅ FETCH COMPLETE CHAT DATA once for all participants
      const completeChat = await Chat.findByPk(chatId, {
        include: [
          {
            model: Message,
            as: 'messages',
            limit: 1, // Only get the latest message
            order: [['createdAt', 'DESC']],
            include: [
              {
                model: User,
                as: 'sender',
                attributes: ['id', 'username', 'avatar', 'publicKey']
              },
              {
                model: Message,
                as: 'replyTo',
                include: [
                  {
                    model: User,
                    as: 'sender',
                    attributes: ['id', 'username', 'avatar']
                  }
                ]
              }
            ]
          },
          {
            model: User,
            as: 'participants',
            attributes: ['id', 'username', 'avatar', 'isOnline'],
            through: {
              attributes: ['role', 'joinedAt']
            }
          }
        ]
      });

      if (!completeChat) {
        console.error(`Group chat ${chatId} not found`);
        return [];
      }

      // Create notifications for all participants with complete chat data
      const notifications = await Promise.all(
        recipients.map(recipientId =>
          this.notifyNewMessage({ 
            ...messageData, 
            receiverId: recipientId,
            // Pass the complete chat data to avoid re-fetching
            _completeChatData: completeChat
          })
        )
      );

      const successCount = notifications.filter(n => n !== null).length;
      console.log(`👥 Queued ${successCount}/${recipients.length} group message notifications with complete chat data`);
      return notifications;
    } catch (error) {
      console.error('Notify group message error:', error);
      return [];
    }
  }
}

module.exports = new NotificationService();
