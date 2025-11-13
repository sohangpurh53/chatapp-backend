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

    // Add creator as participant
    await ChatParticipant.create({
      userId,
      chatId: chat.id,
      role: isGroup ? 'admin' : 'member'
    });

    // Add other participants
    for (const participantId of participantIds) {
      await ChatParticipant.create({
        userId: participantId,
        chatId: chat.id,
        role: 'member'
      });
    }

    // Fetch complete chat data
    const includeOptions = [{
      model: User,
      as: 'participants',
      attributes: ['id', 'username', 'avatar', 'isOnline'],
      through: { where: { isActive: true } }
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

    res.status(201).json({ chat: completeChat });
  } catch (error) {
    console.error('Create chat error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getUserChats = async (req, res) => {
  try {
    const userId = req.user.id;

    const chats = await Chat.findAll({
      include: [
        {
          model: User,
          as: 'participants',
          attributes: ['id', 'username', 'avatar', 'isOnline'],
          through: { 
            where: { isActive: true },
            attributes: []
          },
          required: true
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
      // where: {
      //   '$participants.id$': userId
      // },
      order: [['updatedAt', 'DESC']],
      distinct: true
    });

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
          attributes: ['id', 'content', 'messageType'],
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

    res.json({ chat });
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

module.exports = {
  createChat,
  getUserChats,
  getChatMessages,
  searchUsers,
  inviteToGroup,
  respondToGroupInvite,
  updateGroupInfo,
  markMessageAsRead
};