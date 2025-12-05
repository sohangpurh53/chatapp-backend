const { Message, User, Chat, ChatParticipant, Call, MessageReceipt } = require('../models');
const { Op } = require('sequelize');
const redisService = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const notificationService = require('../services/notificationService');

class SocketHandlers {
  constructor(io) {
    this.io = io;
    this.connectedUsers = new Map(); // userId -> socketId
    this.typingUsers = new Map(); // chatId -> Set of userIds
    this.activeCalls = new Map(); // callId -> callData
    this.userCalls = new Map(); // userId -> callId
  }

  handleConnection(socket) {
    console.log(`User ${socket.user.username} (${socket.userId}) connected with socket ${socket.id}`);

    // Store user connection
    this.connectedUsers.set(socket.userId, socket.id);

    // Update user online status
    this.updateUserOnlineStatus(socket.userId, true);

    // Join user to their chat rooms
    this.joinUserChats(socket);

    // NEW: Sync pending messages when user connects
    this.syncPendingMessages(socket);

    // Send current online users list to the newly connected user
    const onlineUserIds = Array.from(this.connectedUsers.keys());
    socket.emit('online-users-list', {
      users: onlineUserIds
    });
    
    console.log(`[ONLINE USERS] Total online: ${onlineUserIds.length}`);

    // Handle events
    socket.on('join_chat', (data) => this.handleJoinChat(socket, data));
    socket.on('leave_chat', (data) => this.handleLeaveChat(socket, data));
    socket.on('send_message', (data) => this.handleSendMessage(socket, data));
    socket.on('typing_start', (data) => this.handleTypingStart(socket, data));
    socket.on('typing_stop', (data) => this.handleTypingStop(socket, data));
    socket.on('message_read', (data) => this.handleMessageRead(socket, data));
    socket.on('delete_message', (data) => this.handleDeleteMessage(socket, data));
    socket.on('bulk_delete_messages', (data) => this.handleBulkDeleteMessages(socket, data));
    socket.on('file_downloaded', (data) => this.handleFileDownloaded(socket, data));
    socket.on('get-online-users', () => this.handleGetOnlineUsers(socket));
    

    // ✅ UNIFIED CALL EVENTS - Use only initiate_call (remove duplicate initiate-call)
    socket.on('initiate_call', (data) => this.handleInitiateCall(socket, data));
    socket.on('answer_call', (data) => this.handleAnswerCall(socket, data));
    socket.on('decline_call', (data) => this.handleDeclineCall(socket, data));
    socket.on('end_call', (data) => this.handleEndCall(socket, data));
    socket.on('call_signal', (data) => this.handleCallSignal(socket, data));
    socket.on('toggle_audio', (data) => this.handleToggleAudio(socket, data));
    socket.on('toggle_video', (data) => this.handleToggleVideo(socket, data));
    socket.on('share_screen', (data) => this.handleShareScreen(socket, data));
    socket.on('stop_screen_share', (data) => this.handleStopScreenShare(socket, data));

    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  async joinUserChats(socket) {
    try {
      const userChats = await Chat.findAll({
        include: [{
          model: User,
          as: 'participants',
          where: { id: socket.userId },
          through: { where: { isActive: true } }
        }]
      });

      userChats.forEach(chat => {
        socket.join(`chat_${chat.id}`);
      });
    } catch (error) {
      console.error('Error joining user chats:', error);
    }
  }

  /**
   * NEW: Sync pending messages when user connects
   * Delivers all messages that were missed while offline
   */
  async syncPendingMessages(socket) {
    try {
      console.log(`🔄 Syncing pending messages for user ${socket.userId}`);

      // Get all pending/undelivered messages for this user
      const pendingMessages = await Message.findAll({
        include: [
          {
            model: MessageReceipt,
            as: 'receipts',
            where: {
              userId: socket.userId,
              status: { [Op.in]: ['pending', 'sent'] } // Not delivered yet
            },
            required: true
          },
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
        },
        order: [['createdAt', 'ASC']] // Oldest first
      });

      if (pendingMessages.length > 0) {
        console.log(`📬 Found ${pendingMessages.length} pending messages for user ${socket.userId}`);

        // Send all pending messages
        socket.emit('sync_pending_messages', {
          messages: pendingMessages,
          count: pendingMessages.length
        });

        // Mark all as delivered
        await MessageReceipt.update(
          {
            status: 'delivered',
            deliveryMethod: 'socket',
            deliveredAt: new Date()
          },
          {
            where: {
              userId: socket.userId,
              status: { [Op.in]: ['pending', 'sent'] }
            }
          }
        );

        console.log(`✅ Synced ${pendingMessages.length} pending messages to user ${socket.userId}`);
      } else {
        console.log(`ℹ️  No pending messages for user ${socket.userId}`);
      }
    } catch (error) {
      console.error('Error syncing pending messages:', error);
    }
  }

  handleJoinChat(socket, data) {
    const { chatId } = data;
    socket.join(`chat_${chatId}`);

    // Notify others that user joined
    socket.to(`chat_${chatId}`).emit('user_joined', {
      userId: socket.userId,
      username: socket.user.username
    });
  }

  handleLeaveChat(socket, data) {
    const { chatId } = data;
    socket.leave(`chat_${chatId}`);

    // Notify others that user left
    socket.to(`chat_${chatId}`).emit('user_left', {
      userId: socket.userId,
      username: socket.user.username
    });
  }

  async handleSendMessage(socket, data) {
    try {
      const { 
        chatId, 
        content, 
        messageType = 'text', 
        fileUrl, 
        fileName, 
        fileSize, 
        replyToId,
        encryptedContent,
        isEncrypted = false,
        keyId 
      } = data;

      // Verify user is participant
      const participant = await ChatParticipant.findOne({
        where: {
          userId: socket.userId,
          chatId,
          isActive: true
        }
      });

      if (!participant) {
        socket.emit('error', { message: 'Access denied' });
        return;
      }

      // Get chat info to determine if it's direct or group
      const chat = await Chat.findByPk(chatId);
      if (!chat) {
        socket.emit('error', { message: 'Chat not found' });
        return;
      }

      // For direct chats, set receiverId
      let receiverId = null;
      if (!chat.isGroup) {
        receiverId = chat.participant1Id === socket.userId ? chat.participant2Id : chat.participant1Id;
      }

      // Enhanced encryption support
      let encryptionIv = null;
      let authTag = null;
      let encryptionAlgorithm = null;
      let encryptionVersion = null;

      if (isEncrypted && encryptedContent) {
        encryptionIv = encryptedContent.iv;
        authTag = encryptedContent.authTag;
        encryptionAlgorithm = encryptedContent.algorithm;
        encryptionVersion = encryptedContent.version;
      }

      // Create message with enhanced encryption support
      const message = await Message.create({
        content: isEncrypted ? '[ENCRYPTED]' : content,
        encryptedContent: isEncrypted ? encryptedContent.encryptedContent : null,
        isEncrypted,
        keyId: isEncrypted ? keyId : null,
        encryptionIv,
        authTag,
        encryptionAlgorithm,
        encryptionVersion,
        messageType,
        fileUrl,
        fileName,
        fileSize,
        senderId: socket.userId,
        receiverId,
        chatId,
        replyToId,
        status: 'sent'
      });

      // Fetch complete message data with sender's public key
      const completeMessage = await Message.findByPk(message.id, {
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

      // Update chat's last activity
      await Chat.update(
        { lastActivityAt: new Date() },
        { where: { id: chatId } }
      );

      // Create delivery receipts for all participants (except sender)
      const participants = await ChatParticipant.findAll({
        where: {
          chatId,
          userId: { [Op.ne]: socket.userId },
          isActive: true
        }
      });

      for (const participant of participants) {
        await MessageReceipt.create({
          messageId: message.id,
          userId: participant.userId,
          status: 'delivered'
        });
      }

      // ✅ SIMPLIFIED: Direct socket delivery only
      this.io.to(`chat_${chatId}`).emit('new_message', completeMessage);
      console.log(`📡 Message ${message.id} emitted directly to chat ${chatId}`);

      // Immediate acknowledgment to sender
      socket.emit('message_sent', {
        messageId: message.id,
        status: 'sent',
        timestamp: new Date()
      });

      // ✅ Send FCM only to offline participants
      const fcmService = require('../services/fcmService');
      for (const participant of participants) {
        const isOnline = await redisService.getUserOnlineStatus(participant.userId);
        
        if (!isOnline) {
          console.log(`📱 Sending FCM to offline user ${participant.userId}`);
          try {
            await fcmService.sendNotification(participant.userId, {
              title: message.sender.username,
              body: message.isEncrypted ? '🔒 Encrypted message' : message.content,
              data: {
                type: 'new_message',
                messageId: message.id,
                chatId: message.chatId,
                senderId: message.senderId,
                senderName: message.sender.username
              }
            });
          } catch (fcmError) {
            console.error(`❌ FCM failed for user ${participant.userId}:`, fcmError.message);
          }
        }
      }

    } catch (error) {
      console.error('Send message error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  }

  handleTypingStart(socket, data) {
    const { chatId } = data;

    if (!this.typingUsers.has(chatId)) {
      this.typingUsers.set(chatId, new Set());
    }

    this.typingUsers.get(chatId).add(socket.userId);

    // Notify others in the chat
    socket.to(`chat_${chatId}`).emit('user_typing', {
      userId: socket.userId,
      username: socket.user.username,
      isTyping: true
    });
  }

  handleTypingStop(socket, data) {
    const { chatId } = data;

    if (this.typingUsers.has(chatId)) {
      this.typingUsers.get(chatId).delete(socket.userId);

      if (this.typingUsers.get(chatId).size === 0) {
        this.typingUsers.delete(chatId);
      }
    }

    // Notify others in the chat
    socket.to(`chat_${chatId}`).emit('user_typing', {
      userId: socket.userId,
      username: socket.user.username,
      isTyping: false
    });
  }

  async handleMessageRead(socket, data) {
    try {
      const { messageId, chatId } = data;

      // Update message receipt
      const [receipt, created] = await MessageReceipt.findOrCreate({
        where: { messageId, userId: socket.userId },
        defaults: { status: 'read', timestamp: new Date() }
      });

      if (!created && receipt.status !== 'read') {
        receipt.status = 'read';
        receipt.timestamp = new Date();
        await receipt.save();
      }

      // Update participant's last read message
      await ChatParticipant.update(
        { lastReadMessageId: messageId },
        {
          where: {
            userId: socket.userId,
            chatId,
            isActive: true
          }
        }
      );

      // Notify sender that message was read
      socket.to(`chat_${chatId}`).emit('message_read', {
        messageId,
        readBy: socket.userId,
        readAt: new Date()
      });

    } catch (error) {
      console.error('Message read error:', error);
    }
  }

  async handleDeleteMessage(socket, data) {
    try {
      const { messageId, deleteForEveryone = false } = data;
      const userId = socket.userId;

      const message = await Message.findByPk(messageId);
      if (!message) {
        socket.emit('error', { message: 'Message not found' });
        return;
      }

      // Verify user is participant in the chat
      const participant = await ChatParticipant.findOne({
        where: {
          userId,
          chatId: message.chatId,
          isActive: true
        }
      });

      if (!participant) {
        socket.emit('error', { message: 'Access denied' });
        return;
      }

      if (deleteForEveryone) {
        // Only sender can delete for everyone
        if (message.senderId !== userId) {
          socket.emit('error', { message: 'Only sender can delete message for everyone' });
          return;
        }

        // Check if message is within 1 hour (optional time limit)
        const messageAge = Date.now() - new Date(message.createdAt).getTime();
        const oneHour = 60 * 60 * 1000;
        
        if (messageAge > oneHour) {
          socket.emit('error', { message: 'Cannot delete messages older than 1 hour for everyone' });
          return;
        }

        // Mark message as deleted
        await message.update({
          content: 'This message was deleted',
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: userId
        });

        // Emit to all participants in the chat (including sender)
        this.io.to(`chat_${message.chatId}`).emit('message_deleted', {
          messageId,
          chatId: message.chatId,
          deletedBy: userId,
          deleteForEveryone: true
        });

        console.log(`Message ${messageId} deleted for everyone by user ${userId}`);
      } else {
        // Delete for me - add to UserMessageDeletion table
        const { UserMessageDeletion } = require('../models');
        
        await UserMessageDeletion.findOrCreate({
          where: {
            userId,
            messageId
          },
          defaults: {
            deletedAt: new Date()
          }
        });

        // Only notify the user who deleted it
        socket.emit('message_deleted', {
          messageId,
          chatId: message.chatId,
          deletedBy: userId,
          deleteForEveryone: false
        });

        console.log(`Message ${messageId} deleted for user ${userId}`);
      }

    } catch (error) {
      console.error('Delete message error:', error);
      socket.emit('error', { message: 'Failed to delete message' });
    }
  }

  async handleBulkDeleteMessages(socket, data) {
    try {
      const { messageIds, deleteForEveryone = false } = data;
      const userId = socket.userId;

      if (!messageIds || messageIds.length === 0) {
        socket.emit('error', { message: 'No messages specified' });
        return;
      }

      if (messageIds.length > 100) {
        socket.emit('error', { message: 'Cannot delete more than 100 messages at once' });
        return;
      }

      const messages = await Message.findAll({
        where: { id: { [Op.in]: messageIds } }
      });

      if (messages.length === 0) {
        socket.emit('error', { message: 'No messages found' });
        return;
      }

      // Get unique chat IDs
      const chatIds = [...new Set(messages.map(m => m.chatId))];

      // Verify user is participant in all chats
      const participations = await ChatParticipant.findAll({
        where: {
          userId,
          chatId: { [Op.in]: chatIds },
          isActive: true
        }
      });

      if (participations.length !== chatIds.length) {
        socket.emit('error', { message: 'Access denied to some messages' });
        return;
      }

      let deletedCount = 0;
      let failedCount = 0;

      if (deleteForEveryone) {
        const oneHour = 60 * 60 * 1000;
        const now = Date.now();

        for (const message of messages) {
          // Check if user is sender
          if (message.senderId !== userId) {
            failedCount++;
            continue;
          }

          // Check time limit
          const messageAge = now - new Date(message.createdAt).getTime();
          if (messageAge > oneHour) {
            failedCount++;
            continue;
          }

          // Delete message
          await message.update({
            content: 'This message was deleted',
            isDeleted: true,
            deletedAt: new Date(),
            deletedBy: userId
          });

          // Emit to all participants
          this.io.to(`chat_${message.chatId}`).emit('message_deleted', {
            messageId: message.id,
            chatId: message.chatId,
            deletedBy: userId,
            deleteForEveryone: true
          });

          deletedCount++;
        }

        console.log(`Bulk deleted ${deletedCount} messages for everyone by user ${userId}`);
      } else {
        // Delete for me
        const { UserMessageDeletion } = require('../models');
        const deletions = messageIds.map(messageId => ({
          userId,
          messageId,
          deletedAt: new Date()
        }));

        const result = await UserMessageDeletion.bulkCreate(deletions, {
          ignoreDuplicates: true
        });

        deletedCount = result.length;

        // Notify only the user
        for (const message of messages) {
          socket.emit('message_deleted', {
            messageId: message.id,
            chatId: message.chatId,
            deletedBy: userId,
            deleteForEveryone: false
          });
        }

        console.log(`Bulk deleted ${deletedCount} messages for user ${userId}`);
      }

      // Send result back to client
      socket.emit('bulk_delete_result', {
        success: true,
        deletedCount,
        failedCount
      });

    } catch (error) {
      console.error('Bulk delete messages error:', error);
      socket.emit('error', { message: 'Failed to bulk delete messages' });
    }
  }

  async handleDisconnect(socket) {
    console.log(`User ${socket.user.username} disconnected`);

    // Handle active call cleanup
    const userCallId = this.userCalls?.get(socket?.userId);
    if (userCallId) {
      await this.endCall(userCallId, 'network_error');

      // Notify other participant about disconnection
      const callData = await redisService.getActiveCall(userCallId);
      if (callData) {
        const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
        const otherSocketId = this.connectedUsers.get(otherUserId);

        if (otherSocketId) {
          this.io.to(otherSocketId).emit('call_ended', {
            callId: userCallId,
            endedBy: socket.userId,
            reason: 'network_error'
          });
        }
      }
    }

    // Remove from connected users
    this.connectedUsers.delete(socket.userId);

    // Update user offline status
    await this.updateUserOnlineStatus(socket.userId, false);

    // Clean up typing status
    this.typingUsers.forEach((users, chatId) => {
      if (users.has(socket.userId)) {
        users.delete(socket.userId);

        // Notify others that user stopped typing
        socket.to(`chat_${chatId}`).emit('user_typing', {
          userId: socket.userId,
          username: socket.user.username,
          isTyping: false
        });

        if (users.size === 0) {
          this.typingUsers.delete(chatId);
        }
      }
    });
  }

  handleGetOnlineUsers(socket) {
    try {
      // Get all online user IDs from connectedUsers map
      const onlineUserIds = Array.from(this.connectedUsers.keys());
      
      console.log(`[GET ONLINE USERS] Sending ${onlineUserIds.length} online users to ${socket.userId}`);
      
      socket.emit('online-users-list', {
        users: onlineUserIds
      });
    } catch (error) {
      console.error('Error getting online users:', error);
    }
  }

  async updateUserOnlineStatus(userId, isOnline) {
    try {
      await User.update(
        {
          isOnline,
          lastSeen: new Date()
        },
        { where: { id: userId } }
      );

      // Update Redis cache
      if (isOnline) {
        await redisService.setUserOnline(userId, this.connectedUsers.get(userId));
      } else {
        await redisService.setUserOffline(userId);
      }

      // Notify all connected users about status change
      this.io.emit('user_status_changed', {
        userId,
        isOnline,
        lastSeen: new Date()
      });
    } catch (error) {
      console.error('Error updating user online status:', error);
    }
  }

  // Call handling methods
  async handleInitiateCall(socket, data) {
    try {
      const { receiverId, callType = 'voice', chatId } = data;
      const callId = uuidv4();

      // Check if receiver exists
      const receiver = await User.findByPk(receiverId);
      if (!receiver) {
        socket.emit('call_error', { message: 'User not found' });
        return;
      }

      // Check if caller is already in a call
      const existingCall = await redisService.getUserCallStatus(socket.userId);
      if (existingCall) {
        socket.emit('call_error', { message: 'You are already in a call' });
        return;
      }

      // Check if receiver is already in a call
      const receiverCall = await redisService.getUserCallStatus(receiverId);
      if (receiverCall) {
        socket.emit('call_error', { message: 'User is busy' });
        return;
      }

      // Check if receiver is online (for Socket.IO delivery)
      const receiverSocketId = this.connectedUsers.get(receiverId);
      const isReceiverOnline = !!receiverSocketId;

      // Create call record
      const call = await Call.create({
        id: callId,
        callerId: socket.userId,
        receiverId,
        chatId,
        callType,
        status: 'initiated'
      });

      // Store call in Redis
      const callData = {
        id: callId,
        callerId: socket.userId,
        receiverId,
        chatId,
        callType,
        status: 'ringing',
        startedAt: new Date(),
        participants: [socket.userId, receiverId]
      };

      await redisService.setActiveCall(callId, callData);
      await redisService.setUserCallStatus(socket.userId, callId, 'calling');
      await redisService.setUserCallStatus(receiverId, callId, 'receiving');

      // Store call mapping
      this.activeCalls.set(callId, callData);
      this.userCalls.set(socket.userId, callId);
      this.userCalls.set(receiverId, callId);

      // Get caller info
      const caller = await User.findByPk(socket.userId, {
        attributes: ['id', 'username', 'avatar']
      });

      // ✅ ENHANCED: Send initial status to caller
      socket.emit('call_status_update', {
        callId,
        status: 'calling',
        receiverOnline: isReceiverOnline
      });

      // ✅ SIMPLIFIED: Direct socket delivery for online users, FCM only for offline
      if (isReceiverOnline && receiverSocketId) {
        console.log(`📡 Receiver ${receiverId} is ONLINE, sending via Socket.IO ONLY`);
        this.io.to(receiverSocketId).emit('incoming_call', {
          callId,
          caller,
          callType,
          chatId,
          receiverId
        });
        console.log(`✅ Call delivered via socket - NO FCM needed`);
        
        // Update status to ringing
        socket.emit('call_status_update', {
          callId,
          status: 'ringing',
          receiverOnline: true
        });
      } else {
        // User is offline - send FCM notification
        console.log(`📱 Receiver ${receiverId} is OFFLINE, sending FCM notification`);
        const fcmService = require('../services/fcmService');
        
        try {
          await fcmService.sendNotification(receiverId, {
            title: `Incoming ${callType} call`,
            body: `${caller.username} is calling you`,
            data: {
              type: 'incoming_call',
              callId,
              callerId: socket.userId,
              receiverId,
              callType,
              chatId,
              callerName: caller.username,
              callerAvatar: caller.avatar
            },
            android: {
              priority: 'high',
              channelId: 'calls',
              category: 'call',
              fullScreenIntent: true
            }
          });
          console.log(`✅ FCM notification sent to offline user`);
        } catch (fcmError) {
          console.error(`❌ FCM failed:`, fcmError.message);
        }
        
        // Check if user comes online or call is answered within 10 seconds
        setTimeout(async () => {
          const currentCall = await redisService.getActiveCall(callId);
          if (currentCall && currentCall.status === 'ringing') {
            // Still ringing after 10 seconds - user might be unavailable
            socket.emit('call_status_update', {
              callId,
              status: 'unavailable',
              receiverOnline: false
            });
          }
        }, 10000); // 10 seconds
      }

      // Confirm to caller and store call reference
      socket.emit('call_initiated', {
        callId,
        receiverId,
        callType,
        status: isReceiverOnline ? 'ringing' : 'calling', // Different status for offline
        receiverOnline: isReceiverOnline
      });

      // Store the call ID in the socket for easy access
      socket.currentCallId = callId;

      // Set timeout for missed call
      setTimeout(async () => {
        const currentCall = await redisService.getActiveCall(callId);
        if (currentCall && currentCall.status === 'ringing') {
          await this.handleMissedCall(callId);
        }
      }, 30000); // 30 seconds timeout

    } catch (error) {
      console.error('Initiate call error:', error);
      socket.emit('call_error', { message: 'Failed to initiate call' });
    }
  }

  async handleAnswerCall(socket, data) {
    try {
      const { callId } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData || callData.receiverId !== socket.userId) {
        socket.emit('call_error', { message: 'Invalid call' });
        return;
      }

      // Update call status
      callData.status = 'answered';
      callData.answeredAt = new Date();

      await redisService.setActiveCall(callId, callData);
      await Call.update(
        {
          status: 'answered',
          startedAt: new Date()
        },
        { where: { id: callId } }
      );

      // Store the call ID in the socket for easy access
      socket.currentCallId = callId;

      // Notify caller that call was answered (without signal - WebRTC will handle separately)
      const callerSocketId = this.connectedUsers.get(callData.callerId);
      if (callerSocketId) {
        this.io.to(callerSocketId).emit('call_answered', {
          callId,
          receiverId: socket.userId
        });
      }

      socket.emit('call_connected', { callId });

    } catch (error) {
      console.error('Answer call error:', error);
      socket.emit('call_error', { message: 'Failed to answer call' });
    }
  }

  async handleDeclineCall(socket, data) {
    try {
      const { callId } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData || callData.receiverId !== socket.userId) {
        socket.emit('call_error', { message: 'Invalid call' });
        return;
      }

      await this.endCall(callId, 'declined');

      // Notify caller
      const callerSocketId = this.connectedUsers.get(callData.callerId);
      if (callerSocketId) {
        this.io.to(callerSocketId).emit('call_declined', { callId });
      }

    } catch (error) {
      console.error('Decline call error:', error);
      socket.emit('call_error', { message: 'Failed to decline call' });
    }
  }

  async handleEndCall(socket, data) {
    try {
      const { callId } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      // Check if user is part of the call
      if (callData.callerId !== socket.userId && callData.receiverId !== socket.userId) {
        socket.emit('call_error', { message: 'Not authorized to end this call' });
        return;
      }

      await this.endCall(callId, 'normal');

      // Notify other participant
      const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
      const otherSocketId = this.connectedUsers.get(otherUserId);

      if (otherSocketId) {
        this.io.to(otherSocketId).emit('call_ended', {
          callId,
          endedBy: socket.userId,
          reason: 'user_ended'
        });
      }

    } catch (error) {
      console.error('End call error:', error);
      socket.emit('call_error', { message: 'Failed to end call' });
    }
  }

  async handleCallSignal(socket, data) {
    try {
      const { callId, signal, targetUserId } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      // Forward signal to target user
      const targetSocketId = this.connectedUsers.get(targetUserId);
      if (targetSocketId) {
        this.io.to(targetSocketId).emit('call_signal', {
          callId,
          signal,
          fromUserId: socket.userId
        });
      }

    } catch (error) {
      console.error('Call signal error:', error);
    }
  }

  async handleToggleAudio(socket, data) {
    try {
      const { callId, muted } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      // Notify other participant
      const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
      const otherSocketId = this.connectedUsers.get(otherUserId);

      if (otherSocketId) {
        this.io.to(otherSocketId).emit('participant_audio_toggle', {
          callId,
          userId: socket.userId,
          muted
        });
      }

    } catch (error) {
      console.error('Toggle audio error:', error);
    }
  }

  async handleToggleVideo(socket, data) {
    try {
      const { callId, videoEnabled } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      // Notify other participant
      const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
      const otherSocketId = this.connectedUsers.get(otherUserId);

      if (otherSocketId) {
        this.io.to(otherSocketId).emit('participant_video_toggle', {
          callId,
          userId: socket.userId,
          videoEnabled
        });
      }

    } catch (error) {
      console.error('Toggle video error:', error);
    }
  }

  async handleShareScreen(socket, data) {
    try {
      const { callId } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      // Update call data
      callData.screenSharing = {
        userId: socket.userId,
        startedAt: new Date()
      };

      await redisService.setActiveCall(callId, callData);

      // Notify other participant
      const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
      const otherSocketId = this.connectedUsers.get(otherUserId);

      if (otherSocketId) {
        this.io.to(otherSocketId).emit('screen_share_started', {
          callId,
          userId: socket.userId
        });
      }

    } catch (error) {
      console.error('Share screen error:', error);
    }
  }

  async handleStopScreenShare(socket, data) {
    try {
      const { callId } = data;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      // Update call data
      delete callData.screenSharing;
      await redisService.setActiveCall(callId, callData);

      // Notify other participant
      const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
      const otherSocketId = this.connectedUsers.get(otherUserId);

      if (otherSocketId) {
        this.io.to(otherSocketId).emit('screen_share_stopped', {
          callId,
          userId: socket.userId
        });
      }

    } catch (error) {
      console.error('Stop screen share error:', error);
    }
  }

  async handleMissedCall(callId) {
    try {
      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      await this.endCall(callId, 'missed');

      // Notify caller about missed call
      const callerSocketId = this.connectedUsers.get(callData.callerId);
      if (callerSocketId) {
        this.io.to(callerSocketId).emit('call_missed', { callId });
      }

      // Send push notification for missed call
      await notificationService.notifyMissedCall({
        callId,
        callerId: callData.callerId,
        receiverId: callData.receiverId,
        callType: callData.callType
      });

    } catch (error) {
      console.error('Handle missed call error:', error);
    }
  }

  // async endCall(callId, reason = 'normal') {
  //   try {
  //     const callData = await redisService.getActiveCall(callId);
  //     if (!callData) {
  //       return;
  //     }

  //     const duration = callData.answeredAt
  //       ? Math.floor((new Date() - new Date(callData.answeredAt)) / 1000)
  //       : 0;

  //     // Update database
  //     await Call.update(
  //       {
  //         status: reason === 'missed' ? 'missed' : 'ended',
  //         endedAt: new Date(),
  //         duration,
  //         endReason: reason
  //       },
  //       { where: { id: callId } }
  //     );

  //     // Clean up Redis
  //     await redisService.deleteActiveCall(callId);
  //     await redisService.deleteUserCallStatus(callData.callerId);
  //     await redisService.deleteUserCallStatus(callData.receiverId);

  //     // Clean up memory
  //     this.activeCalls.delete(callId);
  //     this.userCalls.delete(callData.callerId);
  //     this.userCalls.delete(callData.receiverId);

  //   } catch (error) {
  //     console.error('End call cleanup error:', error);
  //   }
  // }
  async endCall(callId, reason = 'normal') {
    try {
      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }

      const duration = callData.answeredAt
        ? Math.floor((new Date() - new Date(callData.answeredAt)) / 1000)
        : 0;

      // Map incoming reasons to valid endReason enum values
      const endReasonMap = {
        'declined': 'user_ended',
        'missed': 'no_answer',
        'normal': 'normal',
        'ended': 'user_ended',
        'canceled': 'user_ended',
        'busy': 'busy',
        'no_answer': 'no_answer',
        'network_error': 'network_error',
        'user_ended': 'user_ended'
      };

      // Map incoming reasons to valid status enum values
      const statusMap = {
        'declined': 'declined',
        'missed': 'missed',
        'normal': 'ended',
        'ended': 'ended',
        'canceled': 'declined',
        'busy': 'declined',
        'no_answer': 'missed'
      };

      const endReason = endReasonMap[reason] || 'normal';
      const status = statusMap[reason] || 'ended';

      // Update database
      await Call.update(
        {
          status: status,
          endedAt: new Date(),
          duration,
          endReason: endReason
        },
        { where: { id: callId } }
      );

      // ✅ FIX: ALWAYS clean up Redis, even if database update fails
      await redisService.deleteActiveCall(callId);
      await redisService.deleteUserCallStatus(callData.callerId);
      await redisService.deleteUserCallStatus(callData.receiverId);

      // ✅ FIX: ALWAYS clean up memory maps
      this.activeCalls.delete(callId);
      this.userCalls.delete(callData.callerId);
      this.userCalls.delete(callData.receiverId);

    } catch (error) {
      console.error('End call cleanup error:', error);
      // ✅ FIX: Even on error, try to clean up memory to prevent "user busy" errors
      try {
        if (callId) {
          this.activeCalls.delete(callId);
          // Try to get user IDs from memory if Redis failed
          const callFromMemory = this.activeCalls.get(callId);
          if (callFromMemory) {
            this.userCalls.delete(callFromMemory.callerId);
            this.userCalls.delete(callFromMemory.receiverId);
          }
        }
      } catch (cleanupError) {
        console.error('Emergency cleanup also failed:', cleanupError);
      }
    }
  }

  // Method to send message to specific user
  sendToUser(userId, event, data) {
    const socketId = this.connectedUsers.get(userId);
    if (socketId) {
      this.io.to(socketId).emit(event, data);
    }
  }

  // Method to send message to all users in a chat
  sendToChat(chatId, event, data) {
    this.io.to(`chat_${chatId}`).emit(event, data);
  }



  async handleFileDownloaded(socket, data) {
    try {
      const { messageId } = data;
      const userId = socket.userId;

      console.log(`📥 User ${userId} downloaded file from message ${messageId}`);

      // Find the message with chat info
      const message = await Message.findByPk(messageId, {
        include: [{
          model: Chat,
          as: 'chat',
          attributes: ['id', 'isGroup', 'participant1Id', 'participant2Id']
        }]
      });

      if (!message) {
        console.error('Message not found:', messageId);
        return;
      }

      const chat = message.chat;
      const chatId = chat.id;
      
      if (chat.isGroup) {
        // For group chats, use array
        let downloadedBy = message.downloadedBy || [];
        if (!downloadedBy.includes(userId)) {
          downloadedBy.push(userId);
          await message.update({ downloadedBy });
          console.log(`✅ Updated download status for group message ${messageId}`);
        }
      } else {
        // For direct chats, use participant fields
        const updateData = {};
        
        if (userId === chat.participant1Id) {
          updateData.participant1Downloaded = true;
        } else if (userId === chat.participant2Id) {
          updateData.participant2Downloaded = true;
        }
        
        if (Object.keys(updateData).length > 0) {
          await message.update(updateData);
          console.log(`✅ Updated download status for direct chat message ${messageId}`);
        }
      }

      // Emit to ALL users in the chat (real-time update)
      this.io.to(chatId).emit('file_download_updated', {
        messageId,
        chatId,
        participant1Downloaded: message.participant1Downloaded,
        participant2Downloaded: message.participant2Downloaded,
        downloadedBy: message.downloadedBy,
      });

      console.log(`📡 Emitted download update to chat ${chatId}`);

    } catch (error) {
      console.error('Error tracking file download:', error);
    }
  }
}

module.exports = SocketHandlers;