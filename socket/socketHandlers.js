const { Message, User, Chat, ChatParticipant } = require('../models');

class SocketHandlers {
  constructor(io) {
    this.io = io;
    this.connectedUsers = new Map(); // userId -> socketId
    this.typingUsers = new Map(); // chatId -> Set of userIds
  }

  handleConnection(socket) {
    console.log(`User ${socket.user.username} connected`);
    
    // Store user connection
    this.connectedUsers.set(socket.userId, socket.id);
    
    // Update user online status
    this.updateUserOnlineStatus(socket.userId, true);

    // Join user to their chat rooms
    this.joinUserChats(socket);

    // Handle events
    socket.on('join_chat', (data) => this.handleJoinChat(socket, data));
    socket.on('leave_chat', (data) => this.handleLeaveChat(socket, data));
    socket.on('send_message', (data) => this.handleSendMessage(socket, data));
    socket.on('typing_start', (data) => this.handleTypingStart(socket, data));
    socket.on('typing_stop', (data) => this.handleTypingStop(socket, data));
    socket.on('message_read', (data) => this.handleMessageRead(socket, data));
    
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
      const { chatId, content, messageType = 'text', fileUrl, fileName, fileSize } = data;

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

      // Create message
      const message = await Message.create({
        content,
        messageType,
        fileUrl,
        fileName,
        fileSize,
        senderId: socket.userId,
        chatId
      });

      // Fetch complete message data
      const completeMessage = await Message.findByPk(message.id, {
        include: [{
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar']
        }]
      });

      // Update chat's updatedAt
      await Chat.update(
        { updatedAt: new Date() },
        { where: { id: chatId } }
      );

      // Emit to all participants in the chat
      this.io.to(`chat_${chatId}`).emit('new_message', completeMessage);

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

  handleMessageRead(socket, data) {
    const { messageId, chatId } = data;
    
    // Notify sender that message was read
    socket.to(`chat_${chatId}`).emit('message_read', {
      messageId,
      readBy: socket.userId,
      readAt: new Date()
    });
  }

  async handleDisconnect(socket) {
    console.log(`User ${socket.user.username} disconnected`);
    
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

  async updateUserOnlineStatus(userId, isOnline) {
    try {
      await User.update(
        { 
          isOnline, 
          lastSeen: new Date() 
        },
        { where: { id: userId } }
      );

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
}

module.exports = SocketHandlers;