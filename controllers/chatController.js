const { Chat, User, Message, ChatParticipant, MessageReceipt, GroupInvite } = require('../models');
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

    // Verify user is participant
    const participant = await ChatParticipant.findOne({
      where: {
        userId: req.user.id,
        chatId,
        isActive: true
      }
    });

    if (!participant) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const messages = await Message.findAll({
      where: { chatId },
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

    res.json({ messages: messages.reverse() });
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

      // Check if message is within 1 hour (optional time limit)
      const messageAge = Date.now() - new Date(message.createdAt).getTime();
      const oneHour = 60 * 60 * 1000;
      
      if (messageAge > oneHour) {
        return res.status(400).json({ error: 'Cannot delete messages older than 1 hour for everyone' });
      }

      // Mark message as deleted
      await message.update({
        content: 'This message was deleted',
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId
      });

      console.log(`Message ${messageId} deleted for everyone by user ${userId}`);
    } else {
      // Delete for me - we could implement a separate table for this
      // For now, just return success
      console.log(`Message ${messageId} deleted for user ${userId}`);
    }

    res.json({ success: true, deleteForEveryone });
  } catch (error) {
    console.error('Delete message error:', error);
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
  deleteMessage,
  deleteChat,
  leaveGroup
};