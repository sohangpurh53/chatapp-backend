const { Message, User, Chat, ChatParticipant, Call, MessageReceipt } = require('../models');
const { Op } = require('sequelize');
const redisService = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const notificationService = require('../services/notificationService');
const { isUuid } = require('../utils/ids');
const { blockState, directPeerId } = require('../utils/blocks');

// How long a call rings before it counts as missed. A phone woken by a push needs
// time to start the app and connect before the answer reaches us.
const RING_TIMEOUT_MS = 45000;
// How long a connected app has to acknowledge 'incoming_call' before the phone is
// woken with a push as well
const RING_ACK_TIMEOUT_MS = 2500;
// How long a call outlives its user's last socket closing
const CALL_RECONNECT_GRACE_MS = { answered: 60000, ringing: 15000 };

class SocketHandlers {
  constructor(io) {
    this.io = io;
    this.connectedUsers = new Map(); // userId -> socketId
    this.typingUsers = new Map(); // chatId -> Set of userIds
    this.activeCalls = new Map(); // callId -> callData
    this.userCalls = new Map(); // userId -> callId
    this.callTimeouts = new Map(); // callId -> timeoutId
    this.callLocks = new Map(); // callId -> promise of the last queued task (see runExclusive)
    this.callDisconnectTimers = new Map(); // userId -> timeoutId (see scheduleCallDisconnectCleanup)
    // Overridable so tests can run the real timers in milliseconds
    this.timings = {
      ringTimeoutMs: RING_TIMEOUT_MS,
      ringAckTimeoutMs: RING_ACK_TIMEOUT_MS,
      reconnectGraceMs: { ...CALL_RECONNECT_GRACE_MS },
    };
    this.shadowCalls = new Map(); // callId -> ring timer of a call to someone who blocked the caller
    this.lastWaveAt = new Map(); // `${from}:${to}` -> timestamp (rate limit)
  }

  async handleConnection(socket) {
    console.log(`User ${socket.user.username} (${socket.userId}) connected with socket ${socket.id}`);

    // Store user connection
    this.connectedUsers.set(socket.userId, socket.id);
    // Back within the grace period: the call goes on
    this.cancelCallDisconnectTimer(socket.userId);

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

    // Signals sent while this user's socket was down mid-call (an ICE restart after a
    // network change). Signals for a call that is still ringing wait for answer_call:
    // an app woken by a push isn't ready for them yet.
    try {
      const callId = this.userCalls.get(socket.userId) ||
        (await redisService.getUserCallStatus(socket.userId))?.callId;
      const callData = callId && await redisService.getActiveCall(callId);
      if (callData?.status === 'answered') {
        await this.flushPendingSignals(socket, callId);
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

      // A blocked pair can't message each other. Whoever blocked knows it and is told;
      // the person who was blocked is not: their message looks sent but is dropped.
      const peerId = directPeerId(chat, socket.userId);
      if (peerId) {
        const { blockedByMe, blockedByThem } = await blockState(socket.userId, peerId);
        if (blockedByMe) {
          fail({ message: 'You blocked this user', code: 'USER_BLOCKED', chatId });
          return;
        }
        if (blockedByThem) {
          this.acknowledgeSent(
            socket,
            respond,
            { id: clientMessageId || uuidv4(), chatId, createdAt: new Date(), isEncrypted },
            false
          );
          return;
        }
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

  async handleWaveSend(socket, data) {
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

    const waveBlock = await blockState(socket.userId, toUserId);
    if (waveBlock.blockedByMe || waveBlock.blockedByThem) {
      return socket.emit('wave_result', { toUserId, delivered: false, reason: 'offline' });
    }

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

    // A reconnect can create the new socket before the old one's disconnect
    // arrives (and a user may have several devices). Only go offline when this
    // was the user's last live socket; otherwise point at the remaining one.
    const remainingSocket = this.findLiveSocket(socket.userId, socket.id);
    if (remainingSocket) {
      this.connectedUsers.set(socket.userId, remainingSocket.id);
      console.log(`User ${socket.userId} still connected via socket ${remainingSocket.id}, staying online`);
    } else {
      this.connectedUsers.delete(socket.userId);
      this.scheduleCallDisconnectCleanup(socket.userId);
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

  // ============================================================================
  // CALLS
  // Every call event goes to the user's room (all their sockets, on any server
  // instance) rather than to the single socket id in connectedUsers, which can
  // point at a half-open socket after a reconnect.
  // ============================================================================

  userRoom(userId) {
    return `user_${userId}`;
  }

  /** Whether the user has a socket on this server. */
  isUserConnected(userId) {
    return (this.io.sockets.adapter.rooms.get(this.userRoom(userId))?.size || 0) > 0;
  }

  clearCallTimeout(callId) {
    if (this.callTimeouts.has(callId)) {
      clearTimeout(this.callTimeouts.get(callId));
      this.callTimeouts.delete(callId);
    }
  }

  cancelCallDisconnectTimer(userId) {
    if (this.callDisconnectTimers.has(userId)) {
      clearTimeout(this.callDisconnectTimers.get(userId));
      this.callDisconnectTimers.delete(userId);
    }
  }

  /** The user's live call, after dropping call state that outlived its call. */
  async getLiveCall(userId) {
    const status = await redisService.getUserCallStatus(userId);
    const callData = status && await redisService.getActiveCall(status.callId);
    if (!callData) {
      if (status) await redisService.deleteUserCallStatus(userId);
      this.userCalls.delete(userId);
      return null;
    }
    // A ring nobody ended (server restarted mid-ring), or a call whose user is gone
    // with no reconnect pending (server restarted mid-call)
    const ringingTooLong = callData.status === 'ringing' &&
      Date.now() - new Date(callData.startedAt).getTime() > this.timings.ringTimeoutMs + 5000;
    const abandoned = callData.status === 'answered' &&
      !this.isUserConnected(userId) && !this.callDisconnectTimers.has(userId);
    if (ringingTooLong || abandoned) {
      await this.endCall(callData.id, 'network_error');
      return null;
    }
    return callData;
  }

  async handleInitiateCall(socket, data) {
    try {
      const { receiverId, callType = 'voice', chatId } = data || {};
      if (!receiverId || receiverId === socket.userId) {
        socket.emit('call_error', { message: 'Invalid receiver' });
        return;
      }

      console.log(`📞 Initiating call from ${socket.userId} to ${receiverId}`);

      const [receiver, caller] = await Promise.all([
        User.findByPk(receiverId, { attributes: ['id'] }),
        User.findByPk(socket.userId, { attributes: ['id', 'username', 'avatar'] }),
      ]);
      if (!receiver || !caller) {
        socket.emit('call_error', { message: 'User not found' });
        return;
      }
      const { blockedByMe, blockedByThem } = await blockState(socket.userId, receiverId);
      if (blockedByMe) {
        socket.emit('call_error', { message: 'You blocked this user', code: 'USER_BLOCKED' });
        return;
      }
      if (blockedByThem) {
        this.startShadowCall(socket, receiverId, callType);
        return;
      }

      // The app only lets you call when it has no call of its own, so a call the
      // server still has for the caller is dead: end it properly
      const callerCall = await this.getLiveCall(socket.userId);
      if (callerCall) {
        const otherUserId = callerCall.callerId === socket.userId ? callerCall.receiverId : callerCall.callerId;
        this.io.to(this.userRoom(otherUserId)).emit('call_ended', {
          callId: callerCall.id, endedBy: socket.userId, reason: 'user_ended'
        });
        await this.endCall(callerCall.id, 'normal');
      }

      if (await this.getLiveCall(receiverId)) {
        socket.emit('call_error', { message: 'User is busy' });
        return;
      }

      const callId = uuidv4();
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

      await Call.create({ id: callId, callerId: socket.userId, receiverId, chatId, callType, status: 'initiated' });
      await Promise.all([
        redisService.setActiveCall(callId, callData),
        redisService.setUserCallStatus(socket.userId, callId, 'calling'),
        redisService.setUserCallStatus(receiverId, callId, 'receiving'),
      ]);
      this.activeCalls.set(callId, callData);
      this.userCalls.set(socket.userId, callId);
      this.userCalls.set(receiverId, callId);
      socket.currentCallId = callId;

      this.callTimeouts.set(callId, setTimeout(() => {
        this.callTimeouts.delete(callId);
        this.handleMissedCall(callId);
      }, this.timings.ringTimeoutMs));

      const receiverOnline = this.isUserConnected(receiverId);
      // 'incoming_call' is emitted synchronously at the start of ringReceiver, so it
      // reaches the receiver before the offer the caller sends after 'call_initiated'
      this.ringReceiver(callData, {
        id: caller.id,
        username: caller.username,
        avatar: caller.avatar || null
      }, receiverOnline);

      socket.emit('call_initiated', {
        callId,
        receiverId,
        callType,
        status: receiverOnline ? 'ringing' : 'calling',
        receiverOnline
      });
    } catch (error) {
      console.error('Initiate call error:', error);
      socket.emit('call_error', { message: 'Failed to initiate call' });
    }
  }

  /**
   * A call to someone who blocked the caller. It must look like a call nobody answers:
   * the receiver is never rung and nothing is stored, and the caller gets the usual
   * "missed" after the ring time.
   */
  startShadowCall(socket, receiverId, callType) {
    const callId = uuidv4();
    const callerId = socket.userId;
    const timer = setTimeout(() => {
      this.shadowCalls.delete(callId);
      this.io.to(this.userRoom(callerId)).emit('call_missed', { callId });
    }, this.timings.ringTimeoutMs);
    this.shadowCalls.set(callId, timer);
    socket.emit('call_initiated', { callId, receiverId, callType, status: 'calling', receiverOnline: false });
  }

  /** True when `callId` was a shadow call (now ended) */
  endShadowCall(socket, callId) {
    const timer = callId && this.shadowCalls.get(callId);
    if (!timer) return false;
    clearTimeout(timer);
    this.shadowCalls.delete(callId);
    socket.emit('call_ended', { callId, endedBy: socket.userId, reason: 'user_ended' });
    return true;
  }

  /**
   * Rings every device of the receiver. A connected app acknowledges 'incoming_call';
   * when none does (no socket, or one left half-open by Doze or a network switch)
   * the phone is woken with a high-priority push instead.
   */
  async ringReceiver(callData, caller, receiverOnline) {
    const { id: callId, receiverId, callerId, callType, chatId } = callData;
    try {
      let acknowledged = false;
      if (receiverOnline) {
        const responses = await new Promise((resolve) => {
          this.io.to(this.userRoom(receiverId))
            .timeout(this.timings.ringAckTimeoutMs)
            .emit('incoming_call', { callId, caller, callType, chatId, receiverId }, (_err, res) => resolve(res || []));
        });
        acknowledged = responses.length > 0;
      }

      // The caller may have hung up while we waited
      const current = await redisService.getActiveCall(callId);
      if (!current || current.status !== 'ringing') return;

      if (acknowledged) {
        this.io.to(this.userRoom(callerId)).emit('call_status_update', { callId, status: 'ringing' });
        return;
      }

      console.log(`📱 No app acknowledged call ${callId}, waking ${receiverId} with a push`);
      const fcmService = require('../services/fcmService');
      const ringExpiresAt = new Date(callData.startedAt).getTime() + this.timings.ringTimeoutMs;
      await fcmService.sendNotification(receiverId, {
        type: 'incoming_call_offline',
        ttlMs: Math.max(1000, ringExpiresAt - Date.now()),
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
          ringExpiresAt: String(ringExpiresAt),
          notificationTitle: `Incoming ${callType} call`,
          notificationBody: `${caller.username} is calling you`
        }
      });
    } catch (error) {
      console.error(`❌ Error ringing user ${receiverId} for call ${callId}:`, error);
    }
  }

  /** Stops the ringing notification on a phone that has no socket (woken by a push). */
  async pushCallEnded(userId, callId, endedBy, reason) {
    try {
      const fcmService = require('../services/fcmService');
      await fcmService.sendNotification(userId, {
        type: 'call_ended',
        ttlMs: this.timings.ringTimeoutMs,
        data: {
          type: 'call_ended',
          callId: String(callId),
          endedBy: String(endedBy),
          reason: String(reason),
          action: 'call_ended'
        }
      });
    } catch (error) {
      console.error(`❌ Failed to push call end to user ${userId}:`, error);
    }
  }

  /** Runs `task` once any earlier task for the same call has finished. */
  runExclusive(callId, task) {
    const previous = this.callLocks.get(callId) || Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => {});
    this.callLocks.set(callId, tail);
    tail.then(() => {
      if (this.callLocks.get(callId) === tail) this.callLocks.delete(callId);
    });
    return next;
  }

  // One answer at a time per call: the notification button and the call screen can both
  // send answer_call, and two that read the call as "ringing" together would both go
  // through (the caller would hear "answered" twice)
  handleAnswerCall(socket, data) {
    return this.runExclusive(data && data.callId, () => this.processAnswerCall(socket, data));
  }

  async processAnswerCall(socket, data) {
    try {
      const { callId, hasOffer } = data || {};

      const callData = await redisService.getActiveCall(callId);
      if (!callData || callData.receiverId !== socket.userId) {
        socket.emit('call_error', { callId, message: 'This call has already ended' });
        return;
      }

      socket.currentCallId = callId;

      // Answered twice (notification button, then the call screen): confirm again
      if (callData.status === 'answered') {
        socket.emit('call_connected', { callId });
        return;
      }

      this.clearCallTimeout(callId);
      callData.status = 'answered';
      callData.answeredAt = new Date();
      await redisService.setActiveCall(callId, callData);

      this.io.to(this.userRoom(callData.callerId)).emit('call_answered', {
        callId,
        receiverId: socket.userId
      });
      // The receiver's other devices stop ringing
      socket.to(this.userRoom(socket.userId)).emit('call_ended', {
        callId, endedBy: socket.userId, reason: 'answered_elsewhere'
      });
      socket.emit('call_connected', { callId });

      // A phone woken by a push had no app running when the caller's offer came:
      // hand the stored offer over now, or have the caller send a fresh one
      if (hasOffer) {
        await redisService.deletePendingSignals(socket.userId, callId);
      } else {
        const delivered = await this.flushPendingSignals(socket, callId);
        if (!delivered.offer) {
          this.io.to(this.userRoom(callData.callerId)).emit('call_signal', {
            callId,
            signal: { type: 'request-offer' },
            fromUserId: socket.userId
          });
        }
      }

      Call.update(
        { status: 'answered', startedAt: new Date() },
        { where: { id: callId } }
      ).catch(error => console.error('Answer call DB update error:', error));
    } catch (error) {
      console.error('Answer call error:', error);
      socket.emit('call_error', { callId: data?.callId, message: 'Failed to answer call' });
    }
  }

  /** Sends the signals stored for this user's call while they had no socket. */
  async flushPendingSignals(socket, callId) {
    const signals = await redisService.getPendingSignals(socket.userId, callId);
    await redisService.deletePendingSignals(socket.userId, callId);
    for (const sig of signals) {
      socket.emit('call_signal', { callId, signal: sig.payload, fromUserId: sig.fromUserId || null });
    }
    return { offer: signals.some(sig => sig.type === 'offer') };
  }

  async handleDeclineCall(socket, data) {
    try {
      const { callId } = data || {};

      const callData = await redisService.getActiveCall(callId);
      if (!callData || callData.receiverId !== socket.userId) {
        return;
      }

      await this.endCall(callId, 'declined');

      this.io.to(this.userRoom(callData.callerId)).emit('call_declined', { callId });
      // The receiver's other devices stop ringing
      socket.to(this.userRoom(socket.userId)).emit('call_ended', {
        callId, endedBy: socket.userId, reason: 'declined'
      });
      await redisService.deletePendingSignals(socket.userId, callId);
    } catch (error) {
      console.error('Decline call error:', error);
    }
  }

  async handleEndCall(socket, data) {
    try {
      const { callId } = data || {};

      if (this.endShadowCall(socket, callId)) return;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        socket.emit('call_ended', { callId, endedBy: socket.userId, reason: 'not_found' });
        return;
      }

      if (callData.callerId !== socket.userId && callData.receiverId !== socket.userId) {
        return;
      }

      console.log(`🔚 User ${socket.userId} ending call ${callId}`);

      const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
      const ended = { callId, endedBy: socket.userId, reason: 'user_ended' };

      this.io.to(this.userRoom(otherUserId)).emit('call_ended', ended);
      // The user's other devices (one may still be ringing) stop too
      socket.to(this.userRoom(socket.userId)).emit('call_ended', ended);
      if (!this.isUserConnected(otherUserId)) {
        await this.pushCallEnded(otherUserId, callId, socket.userId, 'user_ended');
      }

      await this.endCall(callId, 'normal');
      socket.emit('call_ended', ended);

      await Promise.all([
        redisService.deletePendingSignals(callData.callerId, callId),
        redisService.deletePendingSignals(callData.receiverId, callId),
      ]);
    } catch (error) {
      console.error('End call error:', error);
    }
  }

  // In order, per call: an offer takes more Redis round trips than the candidates the
  // caller sends right after it, so handled side by side the candidates were stored
  // before the offer (and the offer then deleted them)
  handleCallSignal(socket, data) {
    return this.runExclusive(data && data.callId, () => this.processCallSignal(socket, data));
  }

  async processCallSignal(socket, data) {
    try {
      const { callId, signal, targetUserId } = data || {};
      if (!signal || !signal.type) {
        return;
      }

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        return;
      }
      const participants = [callData.callerId, callData.receiverId];
      if (!participants.includes(socket.userId) || !participants.includes(targetUserId) ||
          targetUserId === socket.userId) {
        return;
      }

      const relay = { callId, signal, fromUserId: socket.userId };
      const connected = this.isUserConnected(targetUserId);
      if (connected) {
        this.io.to(this.userRoom(targetUserId)).emit('call_signal', relay);
      }

      // Kept until the receiver answers (answer_call hands it over when the app says it
      // has no offer) or reconnects mid-call. While the call rings this happens even
      // when a socket is connected: a backgrounded app's socket can be half-open (Doze,
      // MIUI battery saver), so the live copy never arrives and the phone answers from
      // the push on a new socket. A new offer replaces everything stored before it
      // (an ICE restart makes old candidates useless).
      const ringingReceiver = callData.status === 'ringing' && targetUserId === callData.receiverId;
      if (connected && !ringingReceiver) {
        return;
      }
      if (signal.type === 'offer') {
        await redisService.deletePendingSignals(targetUserId, callId);
      }
      await redisService.pushPendingSignal(targetUserId, callId, {
        type: signal.type,
        payload: signal,
        fromUserId: socket.userId,
        timestamp: Date.now(),
        callId
      });
    } catch (error) {
      console.error('❌ Call signal error:', error);
    }
  }

  /** Relays a call event to the other participant. */
  async relayToOtherParticipant(socket, callId, event, payload) {
    const callData = await redisService.getActiveCall(callId);
    if (!callData) {
      return null;
    }
    const otherUserId = callData.callerId === socket.userId ? callData.receiverId : callData.callerId;
    this.io.to(this.userRoom(otherUserId)).emit(event, payload);
    return callData;
  }

  async handleToggleAudio(socket, data) {
    try {
      const { callId, muted } = data;
      await this.relayToOtherParticipant(socket, callId, 'participant_audio_toggle', {
        callId,
        userId: socket.userId,
        muted
      });
    } catch (error) {
      console.error('Toggle audio error:', error);
    }
  }

  async handleToggleVideo(socket, data) {
    try {
      const { callId, videoEnabled } = data;
      await this.relayToOtherParticipant(socket, callId, 'participant_video_toggle', {
        callId,
        userId: socket.userId,
        videoEnabled
      });
    } catch (error) {
      console.error('Toggle video error:', error);
    }
  }

  async handleShareScreen(socket, data) {
    try {
      const { callId } = data;
      const callData = await this.relayToOtherParticipant(socket, callId, 'screen_share_started', {
        callId,
        userId: socket.userId
      });
      if (callData) {
        callData.screenSharing = { userId: socket.userId, startedAt: new Date() };
        await redisService.setActiveCall(callId, callData);
      }
    } catch (error) {
      console.error('Share screen error:', error);
    }
  }

  async handleStopScreenShare(socket, data) {
    try {
      const { callId } = data;
      const callData = await this.relayToOtherParticipant(socket, callId, 'screen_share_stopped', {
        callId,
        userId: socket.userId
      });
      if (callData) {
        delete callData.screenSharing;
        await redisService.setActiveCall(callId, callData);
      }
    } catch (error) {
      console.error('Stop screen share error:', error);
    }
  }

  async handleMissedCall(callId) {
    try {
      const callData = await redisService.getActiveCall(callId);
      if (!callData || callData.status !== 'ringing') {
        return;
      }

      await this.endCall(callId, 'missed');

      this.io.to(this.userRoom(callData.callerId)).emit('call_missed', { callId });
      this.io.to(this.userRoom(callData.receiverId)).emit('call_ended', {
        callId, endedBy: callData.callerId, reason: 'missed'
      });
      if (!this.isUserConnected(callData.receiverId)) {
        await this.pushCallEnded(callData.receiverId, callId, callData.callerId, 'missed');
      }

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

  /**
   * The user's last socket closed. Media flows peer-to-peer and the app reconnects
   * by itself after a network change or a Doze pause, so the call is only ended if
   * the user is still gone after a grace period.
   */
  async scheduleCallDisconnectCleanup(userId) {
    try {
      const callId = this.userCalls.get(userId) || (await redisService.getUserCallStatus(userId))?.callId;
      if (!callId) return;

      const callData = await redisService.getActiveCall(callId);
      if (!callData) {
        await this.forceCleanupUserState(userId);
        return;
      }
      // A ringing receiver is reached by push; the ring timeout ends the call if nobody answers
      if (callData.status === 'ringing' && callData.receiverId === userId) return;

      const grace = callData.status === 'answered'
        ? this.timings.reconnectGraceMs.answered
        : this.timings.reconnectGraceMs.ringing;
      console.log(`⏳ User ${userId} lost their socket during call ${callId}, ending it in ${grace / 1000}s unless they reconnect`);

      this.cancelCallDisconnectTimer(userId);
      this.callDisconnectTimers.set(userId, setTimeout(() => {
        this.callDisconnectTimers.delete(userId);
        if (this.findLiveSocket(userId)) return;
        this.cleanupUserCallState(userId, 'network_error');
      }, grace));
    } catch (error) {
      console.error(`❌ Error scheduling call cleanup for user ${userId}:`, error);
    }
  }

  async cleanupUserCallState(userId, reason = 'normal') {
    try {
      const callIdToClean = this.userCalls.get(userId) ||
        (await redisService.getUserCallStatus(userId))?.callId;

      if (callIdToClean) {
        console.log(`🧹 Ending call ${callIdToClean} of user ${userId} (${reason})`);

        const callData = await redisService.getActiveCall(callIdToClean) ||
                         this.activeCalls.get(callIdToClean);

        await this.endCall(callIdToClean, reason);

        if (callData) {
          const otherUserId = callData.callerId === userId ? callData.receiverId : callData.callerId;
          this.io.to(this.userRoom(otherUserId)).emit('call_ended', {
            callId: callIdToClean,
            endedBy: userId,
            reason
          });
          if (!this.isUserConnected(otherUserId)) {
            await this.pushCallEnded(otherUserId, callIdToClean, userId, reason);
          }
        }
      }

      await this.forceCleanupUserState(userId);
    } catch (error) {
      console.error(`❌ Error in call cleanup for user ${userId}:`, error);
      await this.forceCleanupUserState(userId);
    }
  }

  /**
   * Force cleanup user state (emergency cleanup)
   */
  async forceCleanupUserState(userId) {
    try {
      // Clear from memory maps
      const callId = this.userCalls.get(userId);
      if (callId) {
        this.activeCalls.delete(callId);
        this.userCalls.delete(userId);
        this.clearCallTimeout(callId);
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
          this.clearCallTimeout(cId);
        }
      }
    } catch (error) {
      console.error(`❌ Force cleanup failed for user ${userId}:`, error);
    }
  }

  async endCall(callId, reason = 'normal') {
    try {
      this.clearCallTimeout(callId);

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

      // Clean up Redis and memory first: a failed database update must not leave
      // both users "busy"
      await redisService.deleteActiveCall(callId);
      await redisService.deleteUserCallStatus(callData.callerId);
      await redisService.deleteUserCallStatus(callData.receiverId);
      this.activeCalls.delete(callId);
      this.userCalls.delete(callData.callerId);
      this.userCalls.delete(callData.receiverId);

      await Call.update(
        {
          status: status,
          endedAt: new Date(),
          duration,
          endReason: endReason
        },
        { where: { id: callId } }
      );
    } catch (error) {
      console.error('End call cleanup error:', error);
      this.activeCalls.delete(callId);
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