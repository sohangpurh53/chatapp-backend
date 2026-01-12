const { Chat, User, Message, ChatParticipant, MessageReceipt, GroupInvite, UserMessageDeletion } = require('../models');
const { Op } = require('sequelize');

const createChat = async (req, res) => {
  try {
    const { participantIds, isGroup, name, description } = req.body;
    const userId = req.user.id;

    // For direct chat, ensure only 2 participants
    if (!isGroup && participantIds.length !== 1) {
      return res.status(400).json({ error: 'Direct chat must have exactly 2 participants' });
    }

    // Check if direct chat already exists
    if (!isGroup) {
      const otherUserId = participantIds[0];
      const existingChat = await Chat.findOne({
        where: {
          isGroup: false,
          [Op.or]: [
            { participant1Id: userId, participant2Id: otherUserId },
            { participant1Id: otherUserId, participant2Id: userId }
          ]
        }
      });

      if (existingChat) {
        // Return existing chat with participants
        const completeChat = await Chat.findByPk(existingChat.id, {
          include: [
            {
              model: User,
              as: 'participant1',
              attributes: ['id', 'username', 'avatar', 'isOnline']
            },
            {
              model: User,
              as: 'participant2',
              attributes: ['id', 'username', 'avatar', 'isOnline']
            }
          ]
        });
        return res.json({ chat: completeChat });
      }
    }

    // Create new chat
    const chatData = {
      name: isGroup ? name : null,
      isGroup,
      description: isGroup ? description : null,
      createdBy: userId,
      lastActivityAt: new Date()
    };

    // For direct chats, set participant IDs
    if (!isGroup) {
      chatData.participant1Id = userId;
      chatData.participant2Id = participantIds[0];
    }

    const chat = await Chat.create(chatData);

    // Add creator as participant (admin for groups)
    await ChatParticipant.create({
      userId,
      chatId: chat.id,
      role: isGroup ? 'admin' : 'member',
      isActive: true
    });

    // Add other participants
    for (const participantId of participantIds) {
      // Skip if participant is the creator (avoid duplicates)
      if (participantId !== userId) {
        await ChatParticipant.create({
          userId: participantId,
          chatId: chat.id,
          role: 'member',
          isActive: true
        });
      }
    }

    // Fetch complete chat data with all participants
    const includeOptions = [{
      model: User,
      as: 'participants',
      attributes: ['id', 'username', 'avatar', 'isOnline'],
      through: { 
        where: { isActive: true },
        attributes: ['role', 'joinedAt']
      }
    }];

    if (!isGroup) {
      includeOptions.push(
        {
          model: User,
          as: 'participant1',
          attributes: ['id', 'username', 'avatar', 'isOnline']
        },
        {
          model: User,
          as: 'participant2',
          attributes: ['id', 'username', 'avatar', 'isOnline']
        }
      );
    }

    const completeChat = await Chat.findByPk(chat.id, {
      include: includeOptions
    });

    console.log(`Created chat ${chat.id} with ${completeChat.participants?.length || 0} participants`);

    res.status(201).json({ chat: completeChat });
  } catch (error) {
    console.error('Create chat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getUserChats = async (req, res) => {
  try {
    const userId = req.user.id;

    // First, get all chat IDs where user is a participant
    const userParticipations = await ChatParticipant.findAll({
      where: {
        userId,
        isActive: true
      },
      attributes: ['chatId']
    });

    const chatIds = userParticipations.map(p => p.chatId);

    if (chatIds.length === 0) {
      return res.json({ chats: [] });
    }

    // Then fetch all chats with ALL their participants (only active chats)
    const chats = await Chat.findAll({
      where: {
        id: { [Op.in]: chatIds },
        isActive: true
      },
      include: [
        {
          model: User,
          as: 'participants',
          attributes: ['id', 'username', 'avatar', 'isOnline'],
          through: {
            where: { isActive: true },
            attributes: ['role', 'joinedAt']
          },
          required: false
        },
        {
          model: User,
          as: 'participant1',
          attributes: ['id', 'username', 'avatar', 'isOnline'],
          required: false
        },
        {
          model: User,
          as: 'participant2',
          attributes: ['id', 'username', 'avatar', 'isOnline'],
          required: false
        },
        {
          model: Message,
          as: 'messages',
          limit: 1,
          order: [['createdAt', 'DESC']],
          required: false,
          include: [{
            model: User,
            as: 'sender',
            attributes: ['id', 'username', 'avatar']
          }]
        }
      ],
      order: [['lastActivityAt', 'DESC']],
      distinct: true
    });

    // Log participant counts for debugging
    chats.forEach(chat => {
      console.log(`Chat ${chat.id} (${chat.name || 'Direct'}): ${chat.participants?.length || 0} participants`);
      if (chat.isGroup && chat.participants) {
        chat.participants.forEach(p => {
          console.log(`  - ${p.username} (${p.id}) - Role: ${p.ChatParticipant?.role || 'N/A'}`);
        });
      }
    });

    console.log(`Returning ${chats.length} chats to user ${userId}`);

    res.json({ chats });
  } catch (error) {
    console.error('Get user chats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getChatMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const userId = req.user.id;

    // Verify user is participant
    const participant = await ChatParticipant.findOne({
      where: {
        userId,
        chatId,
        isActive: true
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get messages deleted by this user
    const userDeletedMessages = await UserMessageDeletion.findAll({
      where: { userId },
      attributes: ['messageId']
    });
    const deletedMessageIds = userDeletedMessages.map(d => d.messageId);

    const messages = await Message.findAll({
      where: { 
        chatId,
        // ✅ FIX: Exclude messages deleted for everyone (they should be completely removed from DB now)
        // Since we're now using message.destroy() instead of marking as deleted,
        // deleted messages won't appear in results automatically
        
        // Exclude messages deleted by this user
        id: { [Op.notIn]: deletedMessageIds }
      },
      include: [
        {
          model: User,
          as: 'sender',
          attributes: ['id', 'username', 'avatar']
        },
        {
          model: User,
          as: 'receiver',
          attributes: ['id', 'username', 'avatar'],
          required: false
        },
        {
          model: Message,
          as: 'replyTo',
          attributes: ['id', 'content', 'messageType', 'encryptedContent', 'isEncrypted', 'keyId'],
          include: [{
            model: User,
            as: 'sender',
            attributes: ['id', 'username']
          }],
          required: false
        },
        {
          model: MessageReceipt,
          as: 'receipts',
          include: [{
            model: User,
            as: 'user',
            attributes: ['id', 'username']
          }],
          required: false
        }
      ],
      attributes: {
        include: ['encryptedContent', 'isEncrypted', 'keyId']
      },
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Process encrypted content for each message
    const encryptionService = require('../services/encryptionService');
    const processedMessages = await Promise.all(messages.map(async (message) => {
      const messageData = message.toJSON();
      
      if (messageData.isEncrypted && messageData.encryptedContent) {
        try {
          messageData.encryptedContent = await encryptionService.processEncryptedContentForClient(
            messageData.encryptedContent,
            messageData.encryptionMetadata
          );
        } catch (error) {
          console.error('Failed to process encrypted content for message:', messageData.id, error);
          // Keep original content if processing fails
        }
      }
      
      return messageData;
    }));

    res.json({ messages: processedMessages.reverse() });
  } catch (error) {
    console.error('Get chat messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const searchUsers = async (req, res) => {
  try {
    const { query } = req.query;
    const currentUserId = req.user.id;

    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const users = await User.findAll({
      where: {
        [Op.and]: [
          { id: { [Op.ne]: currentUserId } },
          {
            [Op.or]: [
              { username: { [Op.iLike]: `%${query}%` } },
              { email: { [Op.iLike]: `%${query}%` } }
            ]
          }
        ]
      },
      attributes: ['id', 'username', 'email', 'avatar', 'isOnline'],
      limit: 20
    });

    res.json({ users });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Group management functions
const inviteToGroup = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userIds, message } = req.body;
    const inviterId = req.user.id;

    // Verify chat exists and is a group
    const chat = await Chat.findOne({
      where: { id: chatId, isGroup: true }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Verify inviter is admin or has permission
    const inviterParticipant = await ChatParticipant.findOne({
      where: {
        userId: inviterId,
        chatId,
        isActive: true,
        role: { [Op.in]: ['admin', 'moderator'] }
      }
    });

    if (!inviterParticipant) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const invites = [];
    for (const userId of userIds) {
      // Check if user is already a participant
      const existingParticipant = await ChatParticipant.findOne({
        where: { userId, chatId, isActive: true }
      });

      if (!existingParticipant) {
        const invite = await GroupInvite.create({
          chatId,
          inviterId,
          inviteeId: userId,
          message,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
        });
        invites.push(invite);
      }
    }

    res.json({ invites });
  } catch (error) {
    console.error('Invite to group error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const respondToGroupInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const { action } = req.body; // 'accept' or 'decline'
    const userId = req.user.id;

    const invite = await GroupInvite.findOne({
      where: {
        id: inviteId,
        inviteeId: userId,
        status: 'pending'
      },
      include: [{
        model: Chat,
        as: 'chat'
      }]
    });

    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    if (action === 'accept') {
      // Add user to chat
      await ChatParticipant.create({
        userId,
        chatId: invite.chatId,
        role: 'member'
      });

      invite.status = 'accepted';
    } else if (action === 'decline') {
      invite.status = 'declined';
    }

    await invite.save();
    res.json({ invite });
  } catch (error) {
    console.error('Respond to group invite error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateGroupInfo = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { name, description, avatar } = req.body;
    const userId = req.user.id;

    // Verify user is admin
    const participant = await ChatParticipant.findOne({
      where: {
        userId,
        chatId,
        isActive: true,
        role: { [Op.in]: ['admin', 'moderator'] }
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const chat = await Chat.findByPk(chatId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ error: 'Group not found' });
    }

    await chat.update({
      name: name || chat.name,
      description: description !== undefined ? description : chat.description,
      avatar: avatar !== undefined ? avatar : chat.avatar
    });

    // Fetch updated chat with participants
    const updatedChat = await Chat.findByPk(chatId, {
      include: [{
        model: User,
        as: 'participants',
        attributes: ['id', 'username', 'avatar', 'isOnline'],
        through: { 
          where: { isActive: true },
          attributes: ['role', 'joinedAt']
        }
      }]
    });

    console.log(`Updated group ${chatId}: ${updatedChat.name}`);

    res.json({ 
      success: true,
      chat: updatedChat 
    });
  } catch (error) {
    console.error('Update group info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const markMessageAsRead = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const message = await Message.findByPk(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
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
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create or update message receipt
    const [receipt, created] = await MessageReceipt.findOrCreate({
      where: { messageId, userId },
      defaults: { status: 'read', timestamp: new Date() }
    });

    if (!created && receipt.status !== 'read') {
      receipt.status = 'read';
      receipt.timestamp = new Date();
      await receipt.save();
    }

    // Update participant's last read message
    participant.lastReadMessageId = messageId;
    await participant.save();

    res.json({ success: true });
  } catch (error) {
    console.error('Mark message as read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get encrypted group key for current user
const getGroupKey = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;
    
    // Verify user is member of the group
    const participant = await ChatParticipant.findOne({
      where: { chatId, userId, isActive: true }
    });
    
    if (!participant) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }
    
    // Get encrypted group key for this user
    const { GroupChatKey } = require('../models');
    const groupKey = await GroupChatKey.findOne({
      where: { chatId, userId },
      order: [['keyVersion', 'DESC']]
    });
    
    if (!groupKey) {
      return res.status(404).json({ error: 'Group key not found' });
    }
    
    res.json({
      encryptedGroupKey: groupKey.encryptedGroupKey,
      keyVersion: groupKey.keyVersion
    });
  } catch (error) {
    console.error('Get group key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Create group with encrypted keys
const createGroupWithKeys = async (req, res) => {
  try {
    const { name, description, participantIds, encryptedGroupKeys } = req.body;
    const userId = req.user.id;
    
    if (!name || !participantIds || !encryptedGroupKeys) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Create group chat
    const chat = await Chat.create({
      name,
      description,
      isGroup: true,
      createdBy: userId,
      lastActivityAt: new Date()
    });
    
    // Add creator as admin
    await ChatParticipant.create({
      chatId: chat.id,
      userId,
      role: 'admin',
      isActive: true
    });
    
    // Add other participants
    for (const participantId of participantIds) {
      if (participantId !== userId) {
        await ChatParticipant.create({
          chatId: chat.id,
          userId: participantId,
          role: 'member',
          isActive: true
        });
      }
    }
    
    // Store encrypted group keys for each member
    const { GroupChatKey } = require('../models');
    for (const keyData of encryptedGroupKeys) {
      await GroupChatKey.create({
        chatId: chat.id,
        userId: keyData.userId,
        encryptedGroupKey: keyData.encryptedKey,
        keyVersion: keyData.keyVersion || 1
      });
    }
    
    // Fetch complete chat data
    const completeChat = await Chat.findByPk(chat.id, {
      include: [{
        model: User,
        as: 'participants',
        attributes: ['id', 'username', 'avatar', 'isOnline', 'publicKey'],
        through: { where: { isActive: true } }
      }]
    });
    
    res.status(201).json({ 
      success: true, 
      chat: completeChat 
    });
  } catch (error) {
    console.error('Create group with keys error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Delete message (for everyone or just for me)
const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { deleteForEveryone = false } = req.body;
    const userId = req.user.id;

    const message = await Message.findByPk(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
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
      return res.status(403).json({ error: 'Access denied' });
    }

    if (deleteForEveryone) {
      // Only sender can delete for everyone
      if (message.senderId !== userId) {
        return res.status(403).json({ error: 'Only sender can delete message for everyone' });
      }

      // ✅ FIX: Use different time limits for media vs text
      const messageAge = Date.now() - new Date(message.createdAt).getTime();
      const timeLimit = (message.messageType === 'image' || message.messageType === 'video' || 
                        message.messageType === 'audio' || message.messageType === 'file') 
                        ? 24 * 60 * 60 * 1000 // 24 hours for media
                        : 60 * 60 * 1000; // 1 hour for text
      
      if (messageAge > timeLimit) {
        const limitText = timeLimit === 24 * 60 * 60 * 1000 ? '24 hours' : '1 hour';
        return res.status(400).json({ error: `Cannot delete messages older than ${limitText} for everyone` });
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
            console.log(`🗑️ Deleted media file: ${fileName}`);
          }
        } catch (fileError) {
          console.error('Error deleting media file:', fileError);
          // Don't fail the message deletion if file deletion fails
        }
      }

      // ✅ FIX: Actually delete the message from database
      await message.destroy();

      console.log(`Message ${messageId} deleted for everyone by user ${userId}`);
    } else {
      // Delete for me - add to UserMessageDeletion table
      await UserMessageDeletion.findOrCreate({
        where: {
          userId,
          messageId
        },
        defaults: {
          deletedAt: new Date()
        }
      });

      console.log(`Message ${messageId} deleted for user ${userId}`);
    }

    res.json({ success: true, deleteForEveryone });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Bulk delete messages
const bulkDeleteMessages = async (req, res) => {
  try {
    const { messageIds, deleteForEveryone = false } = req.body;
    const userId = req.user.id;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ error: 'Message IDs are required' });
    }

    // Limit bulk operations to prevent abuse
    if (messageIds.length > 100) {
      return res.status(400).json({ error: 'Cannot delete more than 100 messages at once' });
    }

    // Fetch all messages
    const messages = await Message.findAll({
      where: {
        id: { [Op.in]: messageIds }
      }
    });

    if (messages.length === 0) {
      return res.status(404).json({ error: 'No messages found' });
    }

    // Verify user is participant in all chats
    const chatIds = [...new Set(messages.map(m => m.chatId))];
    const participations = await ChatParticipant.findAll({
      where: {
        userId,
        chatId: { [Op.in]: chatIds },
        isActive: true
      }
    });

    if (participations.length !== chatIds.length) {
      return res.status(403).json({ error: 'Access denied to some messages' });
    }

    let deletedCount = 0;
    let failedCount = 0;
    const errors = [];

    if (deleteForEveryone) {
      // Delete for everyone - only for messages sent by user and within time limit
      const oneHour = 60 * 60 * 1000;
      const now = Date.now();

      for (const message of messages) {
        // Check if user is sender
        if (message.senderId !== userId) {
          failedCount++;
          errors.push(`Message ${message.id}: Only sender can delete for everyone`);
          continue;
        }

        // Check time limit
        const messageAge = now - new Date(message.createdAt).getTime();
        if (messageAge > oneHour) {
          failedCount++;
          errors.push(`Message ${message.id}: Cannot delete messages older than 1 hour`);
          continue;
        }

        // Delete message
        await message.update({
          content: 'This message was deleted',
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: userId
        });
        deletedCount++;
      }

      console.log(`Bulk deleted ${deletedCount} messages for everyone by user ${userId}`);
    } else {
      // Delete for me - add all to UserMessageDeletion table
      const deletions = messageIds.map(messageId => ({
        userId,
        messageId,
        deletedAt: new Date()
      }));

      // Use bulkCreate with ignoreDuplicates to handle already deleted messages
      const result = await UserMessageDeletion.bulkCreate(deletions, {
        ignoreDuplicates: true
      });

      deletedCount = result.length;
      console.log(`Bulk deleted ${deletedCount} messages for user ${userId}`);
    }

    res.json({ 
      success: true, 
      deleteForEveryone,
      deletedCount,
      failedCount,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Bulk delete messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Delete chat (for direct chats) or leave group
const deleteChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;

    const chat = await Chat.findByPk(chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Verify user is participant
    const participant = await ChatParticipant.findOne({
      where: {
        userId,
        chatId,
        isActive: true
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (chat.isGroup) {
      // For groups, check if user is admin
      if (participant.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can delete groups' });
      }

      // Delete the entire group
      await ChatParticipant.update(
        { isActive: false },
        { where: { chatId } }
      );

      await chat.update({ isActive: false });

      console.log(`Group ${chatId} deleted by admin ${userId}`);
    } else {
      // For direct chats, just mark participant as inactive
      await participant.update({ isActive: false });

      // Check if both participants have left
      const activeParticipants = await ChatParticipant.count({
        where: { chatId, isActive: true }
      });

      if (activeParticipants === 0) {
        await chat.update({ isActive: false });
      }

      console.log(`User ${userId} left chat ${chatId}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete chat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Leave group (for non-admin members)
const leaveGroup = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;

    const chat = await Chat.findByPk(chatId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const participant = await ChatParticipant.findOne({
      where: {
        userId,
        chatId,
        isActive: true
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Mark participant as inactive
    await participant.update({ isActive: false });

    // If user was admin, check if there are other admins
    if (participant.role === 'admin') {
      const otherAdmins = await ChatParticipant.count({
        where: {
          chatId,
          isActive: true,
          role: 'admin'
        }
      });

      // If no other admins, promote the first active member
      if (otherAdmins === 0) {
        const firstMember = await ChatParticipant.findOne({
          where: {
            chatId,
            isActive: true
          },
          order: [['joinedAt', 'ASC']]
        });

        if (firstMember) {
          await firstMember.update({ role: 'admin' });
          console.log(`Promoted user ${firstMember.userId} to admin in group ${chatId}`);
        }
      }
    }

    console.log(`User ${userId} left group ${chatId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Leave group error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Update chat settings (mute, etc.)
const updateChatSettings = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;
    const { muteNotifications, disappearingMessages, disappearingMessagesDuration } = req.body;

    // Find the chat and verify user has access
    const chat = await Chat.findByPk(chatId, {
      include: [
        {
          model: User,
          as: 'participants',
          where: { id: userId },
          required: true
        }
      ]
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found or access denied' });
    }

    // Update settings
    const currentSettings = chat.settings || {};
    const newSettings = {
      ...currentSettings,
      ...(muteNotifications !== undefined && { muteNotifications }),
      ...(disappearingMessages !== undefined && { disappearingMessages }),
      ...(disappearingMessagesDuration !== undefined && { disappearingMessagesDuration })
    };

    await chat.update({ settings: newSettings });

    res.json({
      success: true,
      message: 'Chat settings updated successfully',
      settings: newSettings
    });
  } catch (error) {
    console.error('Error updating chat settings:', error);
    res.status(500).json({ error: 'Failed to update chat settings' });
  }
};

// Get chat settings
const getChatSettings = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;

    // Find the chat and verify user has access
    const chat = await Chat.findByPk(chatId, {
      include: [
        {
          model: User,
          as: 'participants',
          where: { id: userId },
          required: true
        }
      ]
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found or access denied' });
    }

    res.json({
      success: true,
      settings: chat.settings || {
        allowMembersToAddOthers: false,
        allowMembersToEditGroupInfo: false,
        muteNotifications: false,
        disappearingMessages: false,
        disappearingMessagesDuration: null
      }
    });
  } catch (error) {
    console.error('Error getting chat settings:', error);
    res.status(500).json({ error: 'Failed to get chat settings' });
  }
};

// Clear chat messages (delete all messages for current user)
const clearChat = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;

    // Verify user has access to this chat
    const chat = await Chat.findByPk(chatId, {
      include: [
        {
          model: User,
          as: 'participants',
          where: { id: userId },
          required: true
        }
      ]
    });

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found or access denied' });
    }

    // Get all messages in this chat
    const messages = await Message.findAll({
      where: { chatId },
      attributes: ['id']
    });

    const messageIds = messages.map(msg => msg.id);

    if (messageIds.length === 0) {
      return res.json({ 
        success: true, 
        message: 'Chat is already empty',
        deletedCount: 0 
      });
    }

    // Create deletion records for all messages (for this user only)
    const deletionRecords = messageIds.map(messageId => ({
      messageId,
      userId,
      deletedAt: new Date()
    }));

    await UserMessageDeletion.bulkCreate(deletionRecords, {
      ignoreDuplicates: true // In case some messages were already deleted
    });

    console.log(`✅ User ${userId} cleared chat ${chatId} - ${messageIds.length} messages hidden`);

    res.json({
      success: true,
      message: 'Chat cleared successfully',
      deletedCount: messageIds.length
    });
  } catch (error) {
    console.error('Clear chat error:', error);
    res.status(500).json({ error: 'Failed to clear chat' });
  }
};

// Rotate group key (when member is removed or for security)
const rotateGroupKey = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { encryptedGroupKeys } = req.body;
    const userId = req.user.id;
    
    // Verify user is admin
    const participant = await ChatParticipant.findOne({
      where: {
        userId,
        chatId,
        isActive: true,
        role: { [Op.in]: ['admin', 'moderator'] }
      }
    });
    
    if (!participant) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    
    // Get current key version
    const { GroupChatKey } = require('../models');
    const currentKey = await GroupChatKey.findOne({
      where: { chatId },
      order: [['keyVersion', 'DESC']]
    });
    
    const newVersion = (currentKey?.keyVersion || 1) + 1;
    
    // Delete old keys
    await GroupChatKey.destroy({ where: { chatId } });
    
    // Store new encrypted group keys
    for (const keyData of encryptedGroupKeys) {
      await GroupChatKey.create({
        chatId,
        userId: keyData.userId,
        encryptedGroupKey: keyData.encryptedKey,
        keyVersion: newVersion
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Group key rotated successfully',
      keyVersion: newVersion
    });
  } catch (error) {
    console.error('Rotate group key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add member group key (when new member joins)
const addMemberGroupKey = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { userId: newMemberId, encryptedGroupKey } = req.body;
    const userId = req.user.id;
    
    // Verify user is admin
    const participant = await ChatParticipant.findOne({
      where: {
        userId,
        chatId,
        isActive: true,
        role: { [Op.in]: ['admin', 'moderator'] }
      }
    });
    
    if (!participant) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    
    // Get current key version
    const { GroupChatKey } = require('../models');
    const currentKey = await GroupChatKey.findOne({
      where: { chatId },
      order: [['keyVersion', 'DESC']]
    });
    
    const keyVersion = currentKey?.keyVersion || 1;
    
    // Store encrypted group key for new member
    await GroupChatKey.create({
      chatId,
      userId: newMemberId,
      encryptedGroupKey,
      keyVersion
    });
    
    res.json({ 
      success: true, 
      message: 'Group key added for new member',
      keyVersion
    });
  } catch (error) {
    console.error('Add member group key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * ✅ NEW: Get full chat data for notifications
 * This endpoint provides complete chat data when client receives FCM notification
 */
const getFullChatData = async (req, res) => {
  try {
    const { chatId } = req.params;
    const userId = req.user.id;

    // Fetch complete chat data with all associations
    const chat = await Chat.findByPk(chatId, {
      include: [
        {
          model: Message,
          as: 'messages',
          limit: 20, // Get recent messages
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

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Check if user has access to this chat
    const hasAccess = chat.isGroup 
      ? chat.participants?.some(p => p.id === userId)
      : (chat.participant1Id === userId || chat.participant2Id === userId);

    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ 
      success: true,
      chat: chat.toJSON()
    });

  } catch (error) {
    console.error('Get full chat data error:', error);
    res.status(500).json({ error: 'Failed to fetch chat data' });
  }
};

module.exports = {
  createChat,
  getUserChats,
  getChatMessages,
  searchUsers,
  inviteToGroup,
  respondToGroupInvite,
  updateGroupInfo,
  markMessageAsRead,
  getGroupKey,
  createGroupWithKeys,
  rotateGroupKey,
  addMemberGroupKey,
  deleteMessage,
  bulkDeleteMessages,
  deleteChat,
  leaveGroup,
  updateChatSettings,
  getChatSettings,
  clearChat,
  getFullChatData
};