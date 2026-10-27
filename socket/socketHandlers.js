const { Message, User, Chat, ChatParticipant, Call, MessageReceipt } = require('../models');
const { Op } = require('sequelize');
const redisService = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const notificationService = require('../services/notificationService');
const { isUuid } = require('../utils/ids');

class SocketHandlers {
  constructor(io) {
    this.io = io;
    this.connectedUsers = new Map(); // userId -> socketId
    this.typingUsers = new Map(); // chatId -> Set of userIds
    this.activeCalls = new Map(); // callId -> callData
    this.userCalls = new Map(); // userId -> callId
    this.callTimeouts = new Map(); // callId -> timeoutId
    this.lastWaveAt = new Map(); // `${from}:${to}` -> timestamp (rate limit)
  }

  async handleConnection(socket) {
    console.log(`User ${socket.user.username} (${socket.userId}) connected with socket ${socket.id}`);

    // Store user connection
    this.connectedUsers.set(socket.userId, socket.id);

    // Update user online status
    this.updateUserOnlineStatus(socket.userId, true);

    // The Redis online key has a 5-minute TTL (so a crashed server can't leave
    // users "online" forever). Refresh it from the engine heartbeat, otherwise
    // users connected longer than 5 minutes look offline and get push
    // notifications while the app is open.
    let lastPresenceRefresh = Date.now();
    socket.conn.on('packet', (packet) => {
      if (packet.type !== 'pong' || Date.now() - lastPresenceRefresh < 60000) return;
      lastPresenceRefresh = Date.now();
      if (this.connectedUsers.get(socket.userId) === socket.id) {
        redisService.setUserOnline(socket.userId, socket.id);
      }
    });

    // Personal room: lets REST controllers reach this user on any server instance
    socket.join(`user_${socket.userId}`);
    // Session room: signing this device out reaches (and disconnects) only its sockets
    if (socket.sessionId) socket.join(`session_${socket.sessionId}`);

    // Join user to their chat rooms
    this.joinUserChats(socket);

    // Apps that speak sync protocol 2 fetch missed messages themselves (GET /chat/sync)
    // and confirm delivery with 'messages_delivered'; older apps get them pushed
    socket.data.syncProtocol = Number(socket.handshake?.auth?.syncProtocol) || 1;
    // What this server can do: apps only rely on acknowledged, de-duplicated sends
    // and GET /chat/sync once a server says so (an older server would ignore the
    // acknowledgement and store every retry as a new message)
    socket.emit('server_features', { messageAck: true, sync: true });
    if (socket.data.syncProtocol < 2) {
      this.syncPendingMessages(socket);
    }

    // Send current online users list to the newly connected user
    const onlineUserIds = Array.from(this.connectedUsers.keys());
    socket.emit('online-users-list', {
      users: onlineUserIds
    });

    console.log(`[ONLINE USERS] Total online: ${onlineUserIds.length}`);

    // Handle events. Registered before anything below awaits: an app with queued
    // messages sends them the moment it connects, and an event that arrives before
    // its handler exists is dropped.
    socket.on('join_chat', (data) => this.handleJoinChat(socket, data));
    socket.on('leave_chat', (data) => this.handleLeaveChat(socket, data));
    socket.on('send_message', (data, ack) => this.handleSendMessage(socket, data, ack));
    socket.on('messages_delivered', (data) => this.handleMessagesDelivered(socket, data));
    socket.on('typing_start', (data) => this.handleTypingStart(socket, data));
    socket.on('typing_stop', (data) => this.handleTypingStop(socket, data));
    socket.on('message_read', (data) => this.handleMessageRead(socket, data));
    socket.on('delete_message', (data) => this.handleDeleteMessage(socket, data));
    socket.on('bulk_delete_messages', (data) => this.handleBulkDeleteMessages(socket, data));
    socket.on('file_downloaded', (data) => this.handleFileDownloaded(socket, data));
    socket.on('get-online-users', () => this.handleGetOnlineUsers(socket));

    // Orbit: ephemeral waves + vibes
    socket.on('wave_send', (data) => this.handleWaveSend(socket, data));
    socket.on('vibe_update', (data) => this.handleVibeUpdate(socket, data));
    

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

    // Deliver any pending signals that were stored while user was offline
    try {
      const pending = await redisService.getPendingSignalsForUser(socket.userId);
      for (const callId of Object.keys(pending)) {
        const signals = pending[callId];
        for (const sig of signals) {
          console.log(`📤 Delivering pending signal for call ${callId} to user ${socket.userId}`);
          socket.emit('call_signal', {
            callId,
            signal: sig.payload,
            fromUserId: sig.payload.fromUserId || null
          });
        }
        // Remove delivered pending signals
        await redisService.deletePendingSignals(socket.userId, callId);
      }
    } catch (err) {
      console.error('Error delivering pending signals on connect:', err);
    }
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
        order: [['createdAt', 'ASC']], // Oldest first
        // One socket payload; anything beyond this arrives through the chat's own page
        limit: 500
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
              messageId: { [Op.in]: pendingMessages.map(m => m.id) },
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

  async handleSendMessage(socket, data, ack) {
    // The app's outbox passes an acknowledgement callback and learns the outcome
    // there; the 'error' / 'message_sent' events still go out for older apps
    const respond = typeof ack === 'function' ? ack : () => {};
    const clientMessageId = data?.clientMessageId;
    const fail = (payload, retryable = false) => {
      socket.emit('error', clientMessageId ? { ...payload, clientMessageId } : payload);
      respond({ ok: false, clientMessageId, retryable, ...payload });
    };

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
        keyId,
        encryptionMetadata
      } = data;

      console.log('📨 Handling message send:', {
        chatId,
        messageType,
        isEncrypted,
        hasContent: !!content,
        hasEncryptedContent: !!encryptedContent,
        keyId: keyId ? keyId.substring(0, 20) + '...' : null
      });

      // A message the app sends again (it never heard back, or restarted) is
      // acknowledged with the stored copy instead of being stored twice. Checked
      // before slow mode, which would otherwise count the first copy against it.
      if (clientMessageId !== undefined) {
        if (!isUuid(clientMessageId)) {
          fail({ message: 'Invalid message id', code: 'INVALID_MESSAGE_ID', chatId });
          return;
        }
        const existing = await Message.findByPk(clientMessageId, { attributes: ['id', 'senderId', 'chatId', 'createdAt'] });
        if (existing) {
          if (existing.senderId !== socket.userId || existing.chatId !== chatId) {
            fail({ message: 'Message id already in use', code: 'MESSAGE_ID_CONFLICT', chatId });
            return;
          }
          this.acknowledgeSent(socket, respond, existing, true);
          return;
        }
      }

      // Verify user is participant
      const participant = await ChatParticipant.findOne({
        where: {
          userId: socket.userId,
          chatId,
          isActive: true
        }
      });

      if (!participant) {
        fail({ message: 'Access denied', code: 'ACCESS_DENIED', chatId });
        return;
      }

      // Get chat info to determine if it's direct or group
      const chat = await Chat.findByPk(chatId);
      if (!chat) {
        fail({ message: 'Chat not found', code: 'CHAT_NOT_FOUND', chatId });
        return;
      }

      // Group rules: announcement mode and slow mode (admins are exempt)
      if (chat.isGroup && messageType !== 'system') {
        const isAdmin = participant.role === 'admin' || participant.role === 'moderator';
        const groupSettings = chat.settings || {};
        if (!isAdmin && groupSettings.onlyAdminsCanSend) {
          fail({ message: 'Only admins can send messages to this group', code: 'ADMINS_ONLY', chatId });
          return;
        }
        const slowModeSeconds = Number(groupSettings.slowModeSeconds) || 0;
        if (!isAdmin && slowModeSeconds > 0) {
          const lastOwn = await Message.findOne({
            where: { chatId, senderId: socket.userId, messageType: { [Op.ne]: 'system' } },
            order: [['createdAt', 'DESC']],
            attributes: ['createdAt']
          });
          const waitMs = lastOwn ? slowModeSeconds * 1000 - (Date.now() - new Date(lastOwn.createdAt).getTime()) : 0;
          if (waitMs > 0) {
            fail({
              message: `Slow mode is on. You can send again in ${Math.ceil(waitMs / 1000)}s`,
              code: 'SLOW_MODE',
              chatId,
              retryAfter: Math.ceil(waitMs / 1000)
            }, true);
            return;
          }
        }
      }

      // For direct chats, set receiverId
      let receiverId = null;
      if (!chat.isGroup) {
        receiverId = chat.participant1Id === socket.userId ? chat.participant2Id : chat.participant1Id;

        // The receiver may have deleted this chat (which only deactivates them).
        // A new message brings it back for them, otherwise it would never be
        // delivered, notified or listed. Their old messages stay deleted.
        await ChatParticipant.update(
          { isActive: true },
          { where: { chatId, userId: receiverId, isActive: false } }
        );
      }

      // Enhanced encryption support with validation
      let processedEncryptedContent = null;
      let senderEncryptedKey = null;
      let encryptionIv = null;
      let authTag = null;
      let encryptionAlgorithm = null;
      let encryptionVersion = null;

      if (isEncrypted && encryptedContent) {
        // Validate encrypted message format
        const encryptionService = require('../services/encryptionService');
        const validation = encryptionService.validateEncryptedMessage(encryptedContent);
        
        if (!validation.valid) {
          console.error('❌ Invalid encrypted message format:', validation.error);
          fail({ message: `Invalid encryption format: ${validation.error}`, code: 'INVALID_ENCRYPTION', chatId });
          return;
        }

        // Handle large encrypted content with compression
        const compressionResult = await encryptionService.compressEncryptedContent(
          typeof encryptedContent === 'string' ? encryptedContent : JSON.stringify(encryptedContent)
        );

        processedEncryptedContent = compressionResult.content;
        encryptionIv = encryptedContent.iv;
        authTag = encryptedContent.authTag;
        // Use the normalized algorithm from validation (handles case variations)
        encryptionAlgorithm = encryptedContent.algorithm || 'AES-256-CBC';
        encryptionVersion = encryptedContent.version || 1;

        // Extract sender's encrypted key for dual encryption
        if (encryptedContent.senderEncryptedKey) {
          senderEncryptedKey = encryptedContent.senderEncryptedKey;
          console.log('🔐 Extracted sender encrypted key for dual encryption');
        }

        // Store compression metadata
        if (compressionResult.compressed) {
          encryptionMetadata = {
            ...encryptionMetadata,
            compressed: true,
            originalSize: compressionResult.originalSize,
            compressedSize: compressionResult.compressedSize,
            compressionRatio: compressionResult.compressionRatio
          };
        }

        console.log('🔐 Processed encrypted content:', {
          algorithm: encryptionAlgorithm,
          version: encryptionVersion,
          compressed: compressionResult.compressed,
          originalSize: compressionResult.originalSize,
          finalSize: processedEncryptedContent.length,
          hasSenderKey: !!senderEncryptedKey
        });
      }

      // Create message with enhanced encryption support
      const messageData = {
        content: isEncrypted ? '[ENCRYPTED]' : content,
        encryptedContent: processedEncryptedContent,
        senderEncryptedKey,
        isEncrypted,
        keyId: isEncrypted ? keyId : null,
        encryptionIv,
        authTag,
        encryptionAlgorithm,
        encryptionVersion,
        encryptionMetadata,
        messageType,
        fileUrl,
        fileName,
        fileSize,
        senderId: socket.userId,
        receiverId,
        chatId,
        replyToId,
        status: 'sent'
      };
      if (clientMessageId) messageData.id = clientMessageId;

      let message;
      try {
        message = await Message.create(messageData);
      } catch (createError) {
        // The same message sent twice at once: the other copy won, acknowledge it
        if (clientMessageId && createError.name === 'SequelizeUniqueConstraintError') {
          const stored = await Message.findByPk(clientMessageId, { attributes: ['id', 'senderId', 'chatId', 'createdAt'] });
          if (stored && stored.senderId === socket.userId) {
            this.acknowledgeSent(socket, respond, stored, true);
            return;
          }
        }
        throw createError;
      }

      // Fetch complete message data with sender's public key
      const completeMessage = await Message.findByPk(message.id, {
        include: [
          {
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar', 'publicKey', 'encryptionEnabled'],
            required: true
          },
          {
            model: User,
            as: 'receiver',
            attributes: ['id', 'username', 'avatar', 'publicKey', 'encryptionEnabled'],
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
            'senderEncryptedKey',
            'isEncrypted', 
            'keyId',
            'encryptionIv',
            'authTag',
            'encryptionAlgorithm',
            'encryptionVersion',
            'encryptionMetadata'
          ] 
        }
      });

      if (!completeMessage || !completeMessage.sender) {
        console.error(`❌ Failed to fetch complete message data for message ${message.id}`);
        fail({ message: 'Failed to fetch message data', code: 'SEND_FAILED', chatId }, true);
        return;
      }

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

      // A receipt says "delivered" only once the message reached the person's
      // phone: apps on sync protocol 2 confirm that themselves. Older apps can't,
      // so for them being connected right now still counts, as it always has.
      await MessageReceipt.bulkCreate(participants.map(participant => ({
        messageId: message.id,
        userId: participant.userId,
        status: this.isConnectedLegacyApp(participant.userId) ? 'delivered' : 'sent'
      })));

      // Process encrypted content before emitting
      const messageToEmit = completeMessage.toJSON();
      if (messageToEmit.isEncrypted && messageToEmit.encryptedContent) {
        try {
          const encryptionService = require('../services/encryptionService');
          messageToEmit.encryptedContent = await encryptionService.processEncryptedContentForClient(
            messageToEmit.encryptedContent,
            messageToEmit.encryptionMetadata
          );
        } catch (error) {
          console.error('Failed to process encrypted content for broadcast:', error);
          // Keep original content if processing fails
        }
      }

      // Make sure every online participant is in the room. Chats created after a
      // user connected (or rooms left via leave_chat) would otherwise miss this.
      socket.join(`chat_${chatId}`);
      for (const participant of participants) {
        const participantSocketId = this.connectedUsers.get(participant.userId);
        if (participantSocketId) {
          this.io.in(participantSocketId).socketsJoin(`chat_${chatId}`);
        }
      }

      // Emit message to all participants
      this.io.to(`chat_${chatId}`).emit('new_message', messageToEmit);
      
      console.log("📡 Message emitted to chat", {
        chatId,
        messageId: message.id,
        isEncrypted: message.isEncrypted,
        participantCount: participants.length
      });

      // Stored and broadcast: tell the sender
      this.acknowledgeSent(socket, respond, message, false);

      // Send FCM notifications to offline participants
      const notificationService = require('../services/notificationService');
      for (const participant of participants) {
        const isOnline = await redisService.getUserOnlineStatus(participant.userId);
        const isMuted = participant.isMuted && (!participant.mutedUntil || new Date(participant.mutedUntil) > new Date());
        
        if (!isOnline && !isMuted) {
          console.log(`📱 Sending FCM to offline user ${participant.userId}`);
          try {
            await notificationService.notifyNewMessage({
              messageId: message.id,
              senderId: socket.userId,
              receiverId: participant.userId,
              chatId: chatId,
              content: message.content,
              isEncrypted: message.isEncrypted,
              messageType: message.messageType,
              // The ciphertext itself, so the phone can decrypt the notification
              // without fetching the message (it may have no session yet)
              encryptedContent: messageToEmit.encryptedContent,
              createdAt: message.createdAt
            });
          } catch (fcmError) {
            console.error(`❌ FCM notification failed for user ${participant.userId}:`, fcmError.message);
          }
        }
      }

    } catch (error) {
      console.error('Send message error:', error);
      const chatId = data?.chatId;

      // Enhanced error reporting for encryption issues
      if (error.message.includes('too long for type')) {
        fail({
          message: 'Message content too large. Please try a shorter message or enable compression.',
          code: 'MESSAGE_TOO_LARGE',
          chatId
        });
      } else if (error.message.includes('encryption')) {
        fail({
          message: 'Encryption error. Please check your encryption settings.',
          code: 'ENCRYPTION_ERROR',
          chatId
        });
      } else {
        // Database or server trouble: worth trying again
        fail({
          message: 'Failed to send message',
          code: 'SEND_FAILED',
          chatId
        }, true);
      }
    }
  }

  /** 'message_sent' (all apps) and the outbox's acknowledgement for a stored message. */
  acknowledgeSent(socket, respond, message, duplicate) {
    const createdAt = message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt;
    socket.emit('message_sent', {
      messageId: message.id,
      clientMessageId: message.id,
      chatId: message.chatId,
      status: 'sent',
      timestamp: new Date(),
      createdAt,
      isEncrypted: message.isEncrypted
    });
    respond({ ok: true, messageId: message.id, clientMessageId: message.id, createdAt, duplicate });
  }

  /** Connected with an app that can't confirm delivery itself (sync protocol 1). */
  isConnectedLegacyApp(userId) {
    const socketId = this.connectedUsers.get(userId);
    if (!socketId) return false;
    const userSocket = this.io.sockets?.sockets?.get(socketId);
    return !!userSocket && (userSocket.data?.syncProtocol || 1) < 2;
  }

  /**
   * The app stored these messages on the phone: their receipts become "delivered"
   * and each sender hears about it. Only this user's own receipts change, and a
   * receipt that is already "delivered" or "read" stays as it is.
   */
  async handleMessagesDelivered(socket, data) {
    try {
      const ids = Array.isArray(data?.messageIds)
        ? [...new Set(data.messageIds.filter(isUuid))].slice(0, 500)
        : [];
      if (ids.length === 0) return;

      const receipts = await MessageReceipt.findAll({
        where: { messageId: { [Op.in]: ids }, userId: socket.userId, status: { [Op.in]: ['pending', 'sent'] } },
        attributes: ['id', 'messageId']
      });
      if (receipts.length === 0) return;

      const deliveredAt = new Date();
      await MessageReceipt.update(
        { status: 'delivered', timestamp: deliveredAt },
        { where: { id: { [Op.in]: receipts.map(r => r.id) }, status: { [Op.in]: ['pending', 'sent'] } } }
      );

      const messages = await Message.findAll({
        where: { id: { [Op.in]: receipts.map(r => r.messageId) } },
        attributes: ['id', 'chatId', 'senderId']
      });
      for (const message of messages) {
        this.io.to(`user_${message.senderId}`).emit('message_delivered', {
          messageId: message.id,
          chatId: message.chatId,
          userId: socket.userId,
          deliveredAt
        });
      }
    } catch (error) {
      console.error('Messages delivered error:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Orbit: waves (ephemeral nudges) and vibes (24h mood aura)
  // ---------------------------------------------------------------------------

  handleWaveSend(socket, data) {
    const toUserId = data && typeof data.toUserId === 'string' ? data.toUserId : null;
    const emoji = data && typeof data.emoji === 'string' && data.emoji.length <= 8 ? data.emoji : '\u{1F44B}';

    if (!toUserId || toUserId === socket.userId) {
      return socket.emit('wave_result', { toUserId, delivered: false, reason: 'invalid_target' });
    }

    const key = `${socket.userId}:${toUserId}`;
    const now = Date.now();
    if (now - (this.lastWaveAt.get(key) || 0) < 4000) {
      return socket.emit('wave_result', { toUserId, delivered: false, reason: 'rate_limited' });
    }
    this.lastWaveAt.set(key, now);

    const targetSocketId = this.connectedUsers.get(toUserId);
    if (!targetSocketId) {
      return socket.emit('wave_result', { toUserId, delivered: false, reason: 'offline' });
    }

    this.io.to(targetSocketId).emit('wave_received', {
      fromUserId: socket.userId,
      fromUsername: socket.user.username,
      fromAvatar: socket.user.avatar || null,
      emoji,
      sentAt: new Date().toISOString()
    });
    socket.emit('wave_result', { toUserId, delivered: true });
  }

  async handleVibeUpdate(socket, data) {
    try {
      let vibe = null;

      if (data && data.clear !== true) {
        const emoji = typeof data.emoji === 'string' ? data.emoji.slice(0, 8) : '';
        const label = typeof data.label === 'string' ? data.label.trim().slice(0, 40) : '';
        const color = typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color) ? data.color : '#7C5CFF';

        if (!emoji && !label) {
          return socket.emit('vibe_updated', { error: 'Vibe needs an emoji or a label' });
        }

        vibe = { emoji, label, color, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
      }

      await User.update({ vibe }, { where: { id: socket.userId } });

      const payload = { userId: socket.userId, vibe };
      socket.emit('vibe_updated', payload);
      for (const room of socket.rooms) {
        if (typeof room === 'string' && room.startsWith('chat_')) {
          socket.to(room).emit('user_vibe_changed', payload);
        }
      }
    } catch (error) {
      console.error('Error updating vibe:', error);
      socket.emit('vibe_updated', { error: 'Failed to update vibe' });
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
      chatId,
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
      chatId,
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

      // Tell the others it was read, unless the reader turned read receipts off.
      // Members who turned them off themselves don't see others' read ticks either.
      const { readReceiptsEnabled, usersWithReadReceiptsOff } = require('../services/readReceipts');
      if (!(await readReceiptsEnabled(socket.userId))) {
        return;
      }
      const others = await ChatParticipant.findAll({
        where: { chatId, isActive: true, userId: { [Op.ne]: socket.userId } },
        attributes: ['userId']
      });
      const hidden = await usersWithReadReceiptsOff(others.map(p => p.userId));
      const payload = { messageId, chatId, readBy: socket.userId, readAt: new Date() };
      for (const { userId } of others) {
        if (!hidden.has(userId)) {
          this.io.to(`user_${userId}`).emit('message_read', payload);
        }
      }

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

        // ✅ FIX: Remove time limit for media messages or make it longer (24 hours)
        const messageAge = Date.now() - new Date(message.createdAt).getTime();
        const timeLimit = (message.messageType === 'image' || message.messageType === 'video' || 
                          message.messageType === 'audio' || message.messageType === 'file') 
                          ? 24 * 60 * 60 * 1000 // 24 hours for media
                          : 60 * 60 * 1000; // 1 hour for text
        
        if (messageAge > timeLimit) {
          const limitText = timeLimit === 24 * 60 * 60 * 1000 ? '24 hours' : '1 hour';
          socket.emit('error', { message: `Cannot delete messages older than ${limitText} for everyone` });
          return;
        }

        // ✅ FIX: For media messages, delete file from server
        if (message.fileUrl && (message.messageType === 'image' || message.messageType === 'video' || 
                               message.messageType === 'audio' || message.messageType === 'file')) {
          try {
            const fs = require('fs');
            const path = require('path');
            
            // Extract filename from URL
            const urlParts = message.fileUrl.split('/');
            const fileName = urlParts[urlParts.length - 1];
            const filePath = path.join(__dirname, '../public/uploads', fileName);
            
            // Delete file if it exists
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`🗑️ Deleted media file: ${fileName}`);
            }
          } catch (fileError) {
            console.error('Error deleting media file:', fileError);
            // Don't fail the message deletion if file deletion fails
          }
        }

        // ✅ FIX: Actually delete the message from database instead of just marking as deleted
        await message.destroy();

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
        const now = Date.now();

        for (const message of messages) {
          // Check if user is sender
          if (message.senderId !== userId) {
            failedCount++;
            continue;
          }

          // ✅ FIX: Use different time limits for media vs text
          const timeLimit = (message.messageType === 'image' || message.messageType === 'video' || 
                            message.messageType === 'audio' || message.messageType === 'file') 
                            ? 24 * 60 * 60 * 1000 // 24 hours for media
                            : 60 * 60 * 1000; // 1 hour for text

          // Check time limit
          const messageAge = now - new Date(message.createdAt).getTime();
          if (messageAge > timeLimit) {
            failedCount++;
            continue;
          }

          // ✅ FIX: Delete media files from server
          if (message.fileUrl && (message.messageType === 'image' || message.messageType === 'video' || 
                                 message.messageType === 'audio' || message.messageType === 'file')) {
            try {
              const fs = require('fs');
              const path = require('path');
              
              // Extract filename from URL
              const urlParts = message.fileUrl.split('/');
              const fileName = urlParts[urlParts.length - 1];
              const filePath = path.join(__dirname, '../public/uploads', fileName);
              
              // Delete file if it exists
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Bulk deleted media file: ${fileName}`);
              }
            } catch (fileError) {
              console.error('Error deleting media file:', fileError);
              // Don't fail the message deletion if file deletion fails
            }
          }

          // ✅ FIX: Actually delete the message from database
          await message.destroy();

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

    try {
      // ✅ COMPREHENSIVE CALL CLEANUP
      await this.cleanupUserCallState(socket.userId, 'network_error');
    } catch (error) {
      console.error(`❌ Error cleaning up call state for user ${socket.userId}:`, error);
    }

    // A reconnect can create the new socket before the old one's disconnect
    // arrives (and a user may have several devices). Only go offline when this
    // was the user's last live socket; otherwise point at the remaining one.
    const remainingSocket = this.findLiveSocket(socket.userId, socket.id);
    if (remainingSocket) {
      this.connectedUsers.set(socket.userId, remainingSocket.id);
      console.log(`User ${socket.userId} still connected via socket ${remainingSocket.id}, staying online`);
    } else {
      this.connectedUsers.delete(socket.userId);
      await this.updateUserOnlineStatus(socket.userId, false);
    }

    // Clean up typing status
    this.typingUsers.forEach((users, chatId) => {
      if (users.has(socket.userId)) {
        users.delete(socket.userId);

        // Notify others that user stopped typing
        socket.to(`chat_${chatId}`).emit('user_typing', {
          chatId,
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

  /** Another connected socket for this user, if any (excluding `excludeSocketId`). */
  findLiveSocket(userId, excludeSocketId) {
    for (const s of this.io.of('/').sockets.values()) {
      if (s.userId === userId && s.id !== excludeSocketId && s.connected) {
        return s;
      }
    }
    return null;
  }

  /**
   * The server only learns about status through live sockets, so after a
   * restart or crash nobody is online yet. Clears flags left behind in the DB.
   */
  async resetOnlineStatuses() {
    try {
      const [count] = await User.update(
        { isOnline: false },
        { where: { isOnline: true } }
      );
      console.log(`🔄 Reset online status for ${count} users after server start`);
    } catch (error) {
      console.error('Error resetting online statuses:', error);
    }
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

      console.log(`📞 Initiating call from ${socket.userId} to ${receiverId}`);

      // Check if receiver exists
      const receiver = await User.findByPk(receiverId);
      if (!receiver) {
        console.error(`❌ Receiver ${receiverId} not found`);
        socket.emit('call_error', { message: 'User not found' });
        return;
      }

      // ✅ FIX: Clean up any stale call status before checking
      const existingCall = await redisService.getUserCallStatus(socket.userId);
      if (existingCall) {
        console.warn(`⚠️  Caller ${socket.userId} has stale call status, cleaning up...`);
        // Check if the call actually exists
        const callData = await redisService.getActiveCall(existingCall);
        if (!callData) {
          // Stale data, clean it up
          console.log(`🧹 Cleaning up stale call status for caller ${socket.userId}`);
          await redisService.deleteUserCallStatus(socket.userId);
          this.userCalls.delete(socket.userId);
        } else {
          console.error(`❌ Caller ${socket.userId} is already in active call ${existingCall}`);
          socket.emit('call_error', { message: 'You are already in a call' });
          return;
        }
      }

      // ✅ FIX: Clean up any stale call status for receiver before checking
      const receiverCall = await redisService.getUserCallStatus(receiverId);
      if (receiverCall) {
        console.warn(`⚠️  Receiver ${receiverId} has stale call status, checking...`);
        // Check if the call actually exists
        const callData = await redisService.getActiveCall(receiverCall);
        if (!callData) {
          // Stale data, clean it up
          console.log(`🧹 Cleaning up stale call status for receiver ${receiverId}`);
          await redisService.deleteUserCallStatus(receiverId);
          this.userCalls.delete(receiverId);
        } else {
          console.error(`❌ Receiver ${receiverId} is already in active call ${receiverCall}`);
          socket.emit('call_error', { message: 'User is busy' });
          return;
        }
      }

      // Check if receiver is online (for Socket.IO delivery)
      const receiverSocketId = this.connectedUsers.get(receiverId);
      // const isReceiverOnline = !!receiverSocketId;

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

      // ✅ FIX: Verify caller exists
      if (!caller) {
        console.error(`❌ Caller ${socket.userId} not found in database`);
        socket.emit('call_error', { message: 'Caller not found' });
        // Clean up
        await this.endCall(callId, 'error');
        return;
      }

    // ✅ FIX: Send to receiver FIRST, then confirm to caller
    // const receiverSocketId = this.connectedUsers.get(receiverId);
    const isReceiverOnline = !!receiverSocketId;

    // ✅ FIX: Define callerData outside the if block so it's available for both online and offline cases
    const callerData = {
      id: caller.id,
      username: caller.username,
      avatar: caller.avatar || null
    };

    if (isReceiverOnline && receiverSocketId) {
      console.log(`📡 Receiver ${receiverId} is ONLINE, sending via Socket.IO`);
      
      // ✅ CRITICAL: Include receiverId for verification
      this.io.to(receiverSocketId).emit('incoming_call', {
        callId,
        caller: callerData,
        callType,
        chatId,
        receiverId // ✅ ADD THIS for frontend validation
      });
      
      console.log(`✅ Socket event sent to receiver`);
      
      // ✅ Small delay to ensure receiver processes first
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } else {
      console.log(`📱 Receiver ${receiverId} is OFFLINE - sending simplified FCM notification`);
      // ✅ SIMPLIFIED: Send FCM immediately without waiting for signal data
      await this.sendOfflineCallNotification(receiverId, callId, callerData, callType, chatId);
    }

    // ✅ NOW confirm to caller (after receiver was notified)
    socket.emit('call_initiated', {
      callId,
      receiverId,
      callType,
      status: isReceiverOnline ? 'ringing' : 'calling',
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
    }, 30000);

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
        console.warn(`Call ${callId} not found when trying to end`);
        socket.emit('call_ended', { callId, endedBy: socket.userId, reason: 'not_found' });
        return;
      }

      // Check if user is part of the call
      if (callData.callerId !== socket.userId && callData.receiverId !== socket.userId) {
        socket.emit('call_error', { message: 'Not authorized to end this call' });
        return;
      }

      console.log(`🔚 User ${socket.userId} ending call ${callId}`);
      console.log(`📊 Call participants: ${callData.callerId} -> ${callData.receiverId}`);

      // ✅ CRITICAL: Notify other participant BEFORE ending call
      const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
      const otherSocketId = this.connectedUsers.get(otherUserId);

      console.log(`🔍 Other user: ${otherUserId}, Socket ID: ${otherSocketId ? 'ONLINE' : 'OFFLINE'}`);

      // Always try to notify the other user first
      if (otherSocketId) {
        console.log(`📡 Notifying other user ${otherUserId} about call end via Socket.IO`);
        this.io.to(otherSocketId).emit('call_ended', {
          callId,
          endedBy: socket.userId,
          reason: 'user_ended'
        });
        console.log(`✅ Socket.IO call_ended event sent to ${otherUserId}`);
      } else {
        console.log(`📱 Other user ${otherUserId} offline, sending FCM call end notification`);
        // ✅ NEW: Send FCM notification for call end to offline users
        try {
          const fcmService = require('../services/fcmService');
          const fcmResult = await fcmService.sendNotification(otherUserId, {
            title: 'Call ended',
            body: 'The call has ended',
            type: 'call_ended',
            data: {
              type: 'call_ended',
              callId: String(callId),
              endedBy: String(socket.userId),
              reason: 'user_ended',
              action: 'call_ended'
            }
          });
          
          if (fcmResult.success) {
            console.log(`✅ FCM call end notification sent to user ${otherUserId}`);
            console.log(`📬 FCM Message ID: ${fcmResult.messageId}`);
          } else {
            console.log(`⚠️  FCM call end notification failed: ${fcmResult.reason}`);
          }
        } catch (fcmError) {
          console.error(`❌ Failed to send FCM call end notification:`, fcmError);
        }
      }

      // Now end the call
      await this.endCall(callId, 'normal');

      // Confirm to the user who ended the call
      socket.emit('call_ended', {
        callId,
        endedBy: socket.userId,
        reason: 'user_ended'
      });

      console.log(`✅ Call ${callId} ended successfully`);

      // Clean up pending signals related to this call
      try {
        await redisService.deletePendingSignals(callData.callerId, callId);
        await redisService.deletePendingSignals(callData.receiverId, callId);
      } catch (err) {
        console.warn('Error deleting pending signals on call end:', err);
      }

    } catch (error) {
      console.error('End call error:', error);
      socket.emit('call_error', { message: 'Failed to end call' });
    }
  }

  async handleCallSignal(socket, data) {
    try {
      const { callId, signal, targetUserId } = data;

      console.log(`📡 Handling call signal: ${signal.type} for call ${callId} to user ${targetUserId}`);

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        console.warn(`⚠️  No active call found for callId ${callId}`);
        return;
      }

      // ✅ ENHANCED: Validate signal data
      if (!signal || !signal.type) {
        console.error(`❌ Invalid signal data for call ${callId}`);
        socket.emit('call_error', { message: 'Invalid signal data' });
        return;
      }

      // Check if target user is online
      const targetSocketId = this.connectedUsers.get(targetUserId);
      const isTargetOnline = !!targetSocketId;

      if (isTargetOnline) {
        // ✅ Target is online - direct delivery
        console.log(`📤 Target ${targetUserId} is ONLINE - direct signal delivery`);
        this.io.to(targetSocketId).emit('call_signal', {
          callId,
          signal,
          fromUserId: socket.userId
        });
        
        // ✅ Confirm delivery to sender
        socket.emit('signal_delivered', {
          callId,
          targetUserId,
          signalType: signal.type,
          deliveryMethod: 'socket'
        });
      } else {
        // ✅ Target is offline - enhanced persistence and FCM delivery
        console.log(`📥 Target ${targetUserId} is OFFLINE - persisting signal`);
        
        // Store signal with enhanced metadata
        const signalData = {
          type: signal.type,
          payload: signal,
          fromUserId: socket.userId,
          timestamp: Date.now(),
          callId: callId
        };

        await redisService.pushPendingSignal(targetUserId, callId, signalData);
        console.log(`💾 Signal ${signal.type} stored in Redis for offline user ${targetUserId}`);

        // ✅ CRITICAL: Only send FCM for OFFER signals (not ICE candidates)
        if (signal.type === 'offer') {
          console.log(`📱 Sending FCM notification for offer signal`);
          await this.sendSignalViaFCM(targetUserId, callId, signal, callData, socket.userId);
        } else {
          console.log(`📝 Signal ${signal.type} stored but no FCM sent (not an offer)`);
        }
        
        // ✅ Confirm storage to sender
        socket.emit('signal_stored', {
          callId,
          targetUserId,
          signalType: signal.type,
          deliveryMethod: signal.type === 'offer' ? 'fcm_pending' : 'redis_only'
        });
      }

    } catch (error) {
      console.error('❌ Call signal error:', error);
      socket.emit('call_error', { message: 'Signal delivery failed' });
    }
  }

  /**
   * ✅ SIMPLIFIED: Send offline call notification without signal data
   */
  async sendOfflineCallNotification(receiverId, callId, caller, callType, chatId) {
    try {
      const fcmService = require('../services/fcmService');
      
      // Simple FCM payload - no signal data needed
      const fcmPayload = {
        data: {
          type: 'incoming_call_offline',
          callId: String(callId),
          callerId: String(caller.id),
          receiverId: String(receiverId),
          callType: String(callType),
          chatId: chatId ? String(chatId) : '',
          callerName: String(caller.username),
          callerAvatar: String(caller.avatar || ''),
          timestamp: String(Date.now()),
          notificationTitle: `Incoming ${callType} call`,
          notificationBody: `${caller.username} is calling you`
        }
      };

      await fcmService.sendNotification(receiverId, fcmPayload);
      console.log(`✅ Simplified offline call notification sent to user ${receiverId}`);

    } catch (error) {
      console.error(`❌ Error sending offline call notification to user ${receiverId}:`, error);
      throw error;
    }
  }

  /**
   * ✅ NEW: Enhanced FCM delivery with signal data
   */
  async sendSignalViaFCM(targetUserId, callId, signal, callData, fromUserId) {
    try {
      // ✅ Rate limiting: Check if we already sent FCM for this call
      const fcmKey = `fcm_sent:${targetUserId}:${callId}`;
      const alreadySent = await redisService.client.get(fcmKey);
      
      if (alreadySent) {
        console.log(`⚠️  FCM already sent for call ${callId} to user ${targetUserId}, skipping`);
        return;
      }

      const fcmService = require('../services/fcmService');
      
      // Get caller information
      const caller = await User.findByPk(fromUserId, {
        attributes: ['id', 'username', 'avatar']
      });

      if (!caller) {
        console.error(`❌ Caller ${fromUserId} not found for FCM delivery`);
        return;
      }

      // ✅ Prepare DATA-ONLY FCM payload (no default notification)
      // This prevents Firebase from showing default notification
      // Our custom notifee notification will be shown instead
      const fcmPayload = {
        // ✅ FIXED: Move type and priority to data object as strings
        data: {
          type: 'incoming_call_with_signal',
          priority: 'high',
          callId: String(callId),
          callerId: String(fromUserId),
          receiverId: String(targetUserId),
          callType: String(callData.callType),
          chatId: callData.chatId ? String(callData.chatId) : '',
          callerName: String(caller.username),
          callerAvatar: String(caller.avatar || ''),
          // ✅ CRITICAL: Include signal data in FCM payload
          signalType: String(signal.type),
          signalData: JSON.stringify(signal),
          timestamp: String(Date.now()),
          action: 'incoming_call_with_signal',
          // ✅ Include title/body in data for our custom notification
          notificationTitle: `Incoming ${callData.callType} call`,
          notificationBody: `${caller.username} is calling you`
        }
      };

      await fcmService.sendNotification(targetUserId, fcmPayload);
      
      // ✅ Mark FCM as sent for this call (5 minute TTL)
      await redisService.client.setex(fcmKey, 300, 'sent');
      
      console.log(`✅ FCM with ${signal.type} signal sent to offline user ${targetUserId}`);

    } catch (error) {
      console.error(`❌ Error sending FCM with signal to user ${targetUserId}:`, error);
      throw error;
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
  /**
   * ✅ NEW: Comprehensive user call state cleanup
   */
  async cleanupUserCallState(userId, reason = 'normal') {
    try {
      console.log(`🧹 Starting comprehensive cleanup for user ${userId}`);

      // 1. Check memory maps first
      const userCallId = this.userCalls.get(userId);
      
      // 2. Check Redis for any call status
      const redisCallId = await redisService.getUserCallStatus(userId);
      
      // 3. Use whichever call ID we found
      const callIdToClean = userCallId || redisCallId;
      
      if (callIdToClean) {
        console.log(`🧹 Found active call ${callIdToClean} for user ${userId}`);
        
        // Get call data before cleanup
        const callData = await redisService.getActiveCall(callIdToClean) || 
                         this.activeCalls.get(callIdToClean);
        
        // End the call properly
        await this.endCall(callIdToClean, reason);

        // Notify other participant if they exist and are online
        if (callData) {
          const otherUserId = callData.callerId === userId ? callData.receiverId : callData.callerId;
          const otherSocketId = this.connectedUsers.get(otherUserId);

          if (otherSocketId) {
            console.log(`📡 Notifying other user ${otherUserId} about call end`);
            this.io.to(otherSocketId).emit('call_ended', {
              callId: callIdToClean,
              endedBy: userId,
              reason: reason
            });
          }
        }
      }
      
      // 4. Force cleanup any remaining state
      await this.forceCleanupUserState(userId);
      
      console.log(`✅ Comprehensive cleanup completed for user ${userId}`);
      
    } catch (error) {
      console.error(`❌ Error in comprehensive cleanup for user ${userId}:`, error);
      // Still try force cleanup
      await this.forceCleanupUserState(userId);
    }
  }

  /**
   * ✅ NEW: Force cleanup user state (emergency cleanup)
   */
  async forceCleanupUserState(userId) {
    try {
      console.log(`🚨 Force cleanup for user ${userId}`);
      
      // Clear from memory maps
      const callId = this.userCalls.get(userId);
      if (callId) {
        this.activeCalls.delete(callId);
        this.userCalls.delete(userId);
        
        // Clear timeout if exists
        if (this.callTimeouts.has(callId)) {
          clearTimeout(this.callTimeouts.get(callId));
          this.callTimeouts.delete(callId);
        }
      }
      
      // Clear from Redis
      await redisService.deleteUserCallStatus(userId);
      
      // Find and clear any calls where this user is a participant
      for (const [cId, cData] of this.activeCalls.entries()) {
        if (cData.callerId === userId || cData.receiverId === userId) {
          this.activeCalls.delete(cId);
          this.userCalls.delete(cData.callerId);
          this.userCalls.delete(cData.receiverId);
          await redisService.deleteActiveCall(cId);
          
          if (this.callTimeouts.has(cId)) {
            clearTimeout(this.callTimeouts.get(cId));
            this.callTimeouts.delete(cId);
          }
        }
      }
      
      console.log(`✅ Force cleanup completed for user ${userId}`);
      
    } catch (error) {
      console.error(`❌ Force cleanup failed for user ${userId}:`, error);
    }
  }

  async endCall(callId, reason = 'normal') {
    try {
      // ✅ Clear call timeout if it exists
      if (this.callTimeouts.has(callId)) {
        clearTimeout(this.callTimeouts.get(callId));
        this.callTimeouts.delete(callId);
        console.log(`🧹 Cleared timeout for call ${callId}`);
      }

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        // Still try to clean up memory state
        this.activeCalls.delete(callId);
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