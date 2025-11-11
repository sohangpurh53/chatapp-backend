const { Chat, User, Message, ChatParticipant } = require('../models');
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
      const existingChat = await Chat.findOne({
        where: { isGroup: false },
        include: [{
          model: User,
          as: 'participants',
          where: {
            id: { [Op.in]: [userId, ...participantIds] }
          },
          through: { where: { isActive: true } }
        }]
      });

      if (existingChat && existingChat.participants.length === 2) {
        return res.json({ chat: existingChat });
      }
    }

    // Create new chat
    const chat = await Chat.create({
      name: isGroup ? name : null,
      isGroup,
      description: isGroup ? description : null,
      createdBy: userId
    });

    // Add creator as participant
    await ChatParticipant.create({
      userId,
      chatId: chat.id,
      role: 'admin'
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
    const completeChat = await Chat.findByPk(chat.id, {
      include: [{
        model: User,
        as: 'participants',
        attributes: ['id', 'username', 'avatar', 'isOnline'],
        through: { where: { isActive: true } }
      }]
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
          where: { id: userId },
          through: { where: { isActive: true } }
        },
        {
          model: User,
          as: 'participants',
          attributes: ['id', 'username', 'avatar', 'isOnline'],
          through: { where: { isActive: true } }
        },
        {
          model: Message,
          as: 'messages',
          limit: 1,
          order: [['createdAt', 'DESC']],
          include: [{
            model: User,
            as: 'sender',
            attributes: ['id', 'username']
          }]
        }
      ],
      order: [['updatedAt', 'DESC']]
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
      include: [{
        model: User,
        as: 'sender',
        attributes: ['id', 'username', 'avatar']
      }],
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

module.exports = {
  createChat,
  getUserChats,
  getChatMessages,
  searchUsers
};