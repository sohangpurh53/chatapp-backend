const { Chat, User, Message, ChatParticipant, MessageReceipt, GroupInvite, UserMessageDeletion } = require('../models');
const { Op } = require('sequelize');
const {
  isAdminRole,
  DEFAULT_GROUP_SETTINGS,
  groupSettingsOf,
  getIO,
  emitToUsers,
  joinChatRoom,
  leaveChatRoom,
  activeMemberIds,
  postSystemMessage,
  broadcastGroupUpdate,
} = require('../services/groupEvents');

const createChat = async (req, res) => {
  // ✅ Use transaction for data consistency
  const sequelize = require('../config/database');
  const transaction = await sequelize.transaction();
  
  try {
    const { participantIds, isGroup, name, description } = req.body;
    const userId = req.user.id;

    // For direct chat, ensure only 2 participants
    if (!isGroup && participantIds.length !== 1) {
      await transaction.rollback();
      return res.status(400).json({ error: 'Direct chat must have exactly 2 participants' });
    }

    // Check if direct chat already exists
    if (!isGroup) {
      const otherUserId = participantIds[0];
      
      // ✅ ROBUST FIX: Check for existing chat (including soft-deleted ones)
      const existingChat = await Chat.findOne({
        where: {
          isGroup: false,
          [Op.or]: [
            { participant1Id: userId, participant2Id: otherUserId },
            { participant1Id: otherUserId, participant2Id: userId }
          ]
        },
        paranoid: false, // Include soft-deleted chats
        transaction
      });

      if (existingChat) {
        console.log(`📋 Found existing chat ${existingChat.id} (isActive: ${existingChat.isActive})`);
        
        // ✅ Capture original state before updating
        const wasInactive = !existingChat.isActive;
        
        // ✅ If chat was soft-deleted, restore it
        if (!existingChat.isActive) {
          await existingChat.update({ 
            isActive: true,
            lastActivityAt: new Date()
          }, { transaction });
          console.log(`✅ Restored chat ${existingChat.id}`);
        } else {
          // ✅ Update lastActivityAt even if chat was already active
          await existingChat.update({ 
            lastActivityAt: new Date()
          }, { transaction });
          console.log(`✅ Updated lastActivityAt for chat ${existingChat.id}`);
        }

        // ✅ Check both participants' status
        const participants = await ChatParticipant.findAll({
          where: {
            chatId: existingChat.id,
            userId: { [Op.in]: [userId, otherUserId] }
          },
          transaction
        });

        // ✅ Ensure both participants are active
        for (const participant of participants) {
          if (!participant.isActive) {
            await participant.update({ isActive: true }, { transaction });
            console.log(`✅ Reactivated participant ${participant.userId} in chat ${existingChat.id}`);
          }
        }

        // ✅ If any participant is missing, create them
        const participantUserIds = participants.map(p => p.userId);
        const missingUserIds = [userId, otherUserId].filter(id => !participantUserIds.includes(id));
        
        for (const missingUserId of missingUserIds) {
          await ChatParticipant.create({
            userId: missingUserId,
            chatId: existingChat.id,
            role: 'member',
            isActive: true
          }, { transaction });
          console.log(`✅ Created missing participant ${missingUserId} in chat ${existingChat.id}`);
        }

        // ✅ Commit transaction before fetching complete data
        await transaction.commit();

        // ✅ Return complete chat with all data
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
            },
            {
              model: User,
              as: 'participants',
              attributes: ['id', 'username', 'avatar', 'isOnline'],
              through: { 
                where: { isActive: true },
                attributes: ['role', 'joinedAt']
              }
            }
          ]
        });
        
        console.log(`✅ Returning existing/restored chat ${existingChat.id} to user ${userId}`);
        return res.json({ 
          chat: completeChat,
          restored: wasInactive // ✅ Use captured state
        });
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
    if (isGroup) {
      chatData.settings = { ...DEFAULT_GROUP_SETTINGS };
    }

    // For direct chats, set participant IDs
    if (!isGroup) {
      chatData.participant1Id = userId;
      chatData.participant2Id = participantIds[0];
    }

    const chat = await Chat.create(chatData, { transaction });

    // Add creator as participant (admin for groups)
    await ChatParticipant.create({
      userId,
      chatId: chat.id,
      role: isGroup ? 'admin' : 'member',
      isActive: true
    }, { transaction });

    // Add other participants (deduplicated; the creator is already added)
    for (const participantId of [...new Set(participantIds)]) {
      if (participantId !== userId) {
        await ChatParticipant.create({
          userId: participantId,
          chatId: chat.id,
          role: 'member',
          isActive: true
        }, { transaction });
      }
    }

    // ✅ Commit transaction
    await transaction.commit();

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

    console.log(`✅ Created chat ${chat.id} with ${completeChat.participants?.length || 0} participants`);

    if (isGroup) {
      await announceNewGroup(req, chat, [userId, ...participantIds]);
    }

    res.status(201).json({ chat: completeChat });
  } catch (error) {
    // ✅ Rollback transaction on error
    if (transaction && !transaction.finished) {
      await transaction.rollback();
      console.log('🔄 Transaction rolled back due to error');
    }
    console.error('❌ Create chat error:', error);
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

    // The list carries each chat's last message. Like getChatMessages, hand the app
    // encryptedContent as an object (the column holds JSON text, possibly compressed),
    // or it can't decrypt the previews until the chat is opened.
    const encryptionService = require('../services/encryptionService');
    const chatsForClient = await Promise.all(chats.map(async (chat) => {
      const chatData = chat.toJSON();
      await Promise.all((chatData.messages || []).map(async (message) => {
        if (message.isEncrypted && message.encryptedContent) {
          try {
            message.encryptedContent = await encryptionService.processEncryptedContentForClient(
              message.encryptedContent,
              message.encryptionMetadata
            );
          } catch (error) {
            console.error('Failed to process encrypted content for message:', message.id, error);
            // Keep the original content if processing fails
          }
        }
      }));
      return chatData;
    }));

    res.json({ chats: chatsForClient });
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

    // Respect read-receipt privacy (reader's and viewer's)
    const { maskReadReceipts } = require('../services/readReceipts');
    await maskReadReceipts(processedMessages, userId);

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

    const participant = await ChatParticipant.findOne({
      where: { userId, chatId, isActive: true }
    });

    const chat = await Chat.findByPk(chatId);
    if (!chat || !chat.isGroup) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Admins can always edit; members only when the group allows it
    const canEdit = participant && (isAdminRole(participant.role) || groupSettingsOf(chat).allowMembersToEditGroupInfo);
    if (!canEdit) {
      return res.status(403).json({ error: 'Only admins can edit the group info' });
    }

    const before = { name: chat.name, description: chat.description, avatar: chat.avatar };
    await chat.update({
      name: name ? String(name).trim().slice(0, 50) : chat.name,
      description: description !== undefined ? description : chat.description,
      avatar: avatar !== undefined ? avatar : chat.avatar
    });

    const io = getIO(req);
    const actor = await User.findByPk(userId, { attributes: ['username'] });
    const actorName = actor?.username || 'Someone';
    if (chat.name !== before.name) {
      await postSystemMessage(io, chatId, userId, `${actorName} renamed the group to "${chat.name}"`, { type: 'info_changed', key: 'name' });
    }
    if (chat.avatar !== before.avatar) {
      await postSystemMessage(io, chatId, userId, chat.avatar ? `${actorName} changed the group photo` : `${actorName} removed the group photo`, { type: 'info_changed', key: 'avatar' });
    }
    if ((chat.description || '') !== (before.description || '')) {
      await postSystemMessage(io, chatId, userId, `${actorName} updated the group description`, { type: 'info_changed', key: 'description' });
    }
    await broadcastGroupUpdate(io, chatId, [], 'info_changed');

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
// Every key version this member holds. Messages record the version they were
// encrypted with, so history stays readable after the key is rotated.
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

    const { GroupChatKey } = require('../models');
    const rows = await GroupChatKey.findAll({
      where: { chatId, userId },
      order: [['keyVersion', 'ASC']]
    });

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Group key not found' });
    }

    const latest = await GroupChatKey.max('keyVersion', { where: { chatId } });
    const chat = await Chat.findByPk(chatId, { attributes: ['settings'] });
    const mine = rows[rows.length - 1];

    res.json({
      keys: rows.map(r => ({ keyVersion: r.keyVersion, encryptedGroupKey: r.encryptedGroupKey })),
      currentVersion: latest || mine.keyVersion,
      rotationNeeded: !!chat?.settings?.keyRotationNeeded,
      // Latest key this member holds (older clients read only these two fields)
      encryptedGroupKey: mine.encryptedGroupKey,
      keyVersion: mine.keyVersion
    });
  } catch (error) {
    console.error('Get group key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Create group with encrypted keys
const createGroupWithKeys = async (req, res) => {
  const sequelize = require('../config/database');
  const { GroupChatKey } = require('../models');
  let transaction;
  try {
    const { name, description, participantIds, encryptedGroupKeys } = req.body;
    const userId = req.user.id;

    if (!name || !Array.isArray(participantIds) || !Array.isArray(encryptedGroupKeys)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Clients have sent the creator inside participantIds (and twice in the key
    // list). The duplicate key row hit the unique index after the chat was
    // already saved, so the app saw an error for a group that did exist.
    const memberIds = [...new Set(participantIds)].filter(id => id && id !== userId);
    if (memberIds.length === 0) {
      return res.status(400).json({ error: 'A group needs at least one other member' });
    }
    const keysByUser = new Map();
    for (const keyData of encryptedGroupKeys) {
      if (keyData?.userId && keyData?.encryptedKey) keysByUser.set(keyData.userId, keyData);
    }

    transaction = await sequelize.transaction();

    const chat = await Chat.create({
      name: String(name).trim().slice(0, 50),
      description,
      isGroup: true,
      createdBy: userId,
      lastActivityAt: new Date(),
      settings: { ...DEFAULT_GROUP_SETTINGS }
    }, { transaction });

    await ChatParticipant.create({
      chatId: chat.id,
      userId,
      role: 'admin',
      isActive: true
    }, { transaction });

    for (const participantId of memberIds) {
      await ChatParticipant.create({
        chatId: chat.id,
        userId: participantId,
        role: 'member',
        isActive: true
      }, { transaction });
    }

    for (const keyData of keysByUser.values()) {
      if (keyData.userId !== userId && !memberIds.includes(keyData.userId)) continue;
      await GroupChatKey.create({
        chatId: chat.id,
        userId: keyData.userId,
        encryptedGroupKey: keyData.encryptedKey,
        keyVersion: keyData.keyVersion || 1
      }, { transaction });
    }

    await transaction.commit();
    transaction = null;

    const completeChat = await Chat.findByPk(chat.id, {
      include: [{
        model: User,
        as: 'participants',
        attributes: ['id', 'username', 'avatar', 'isOnline', 'publicKey'],
        through: { where: { isActive: true }, attributes: ['role', 'joinedAt'] }
      }]
    });

    await announceNewGroup(req, chat, [userId, ...memberIds]);

    res.status(201).json({
      success: true,
      chat: completeChat
    });
  } catch (error) {
    if (transaction) await transaction.rollback();
    console.error('Create group with keys error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
};

// Put every member's sockets in the new room, drop a "created the group"
// entry in the timeline, and tell the other members' chat lists about it.
const announceNewGroup = async (req, chat, memberIds) => {
  try {
    const io = getIO(req);
    joinChatRoom(io, memberIds, chat.id);
    const creator = await User.findByPk(req.user.id, { attributes: ['username'] });
    await postSystemMessage(io, chat.id, req.user.id, `${creator?.username || 'Someone'} created the group "${chat.name}"`, {
      type: 'group_created'
    });
    emitToUsers(io, memberIds.filter(id => id !== req.user.id), 'group_added', { chatId: chat.id });
  } catch (error) {
    console.error('Announce new group error:', error.message);
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
      if (!isAdminRole(participant.role)) {
        return res.status(403).json({ error: 'Only admins can delete groups' });
      }
      const memberIdsBeforeDelete = await activeMemberIds(chatId);

      // ✅ NEW: Mark all messages as deleted for the admin who is deleting the group
      const messages = await Message.findAll({
        where: { chatId },
        attributes: ['id']
      });

      if (messages.length > 0) {
        const messageIds = messages.map(msg => msg.id);
        
        // Create deletion records for all messages (for this user only)
        const deletionRecords = messageIds.map(messageId => ({
          messageId,
          userId,
          deletedAt: new Date()
        }));

        await UserMessageDeletion.bulkCreate(deletionRecords, {
          ignoreDuplicates: true
        });

        console.log(`✅ Marked ${messageIds.length} messages as deleted for admin ${userId} in group ${chatId}`);
      }

      // Delete the entire group - mark all participants as inactive
      await ChatParticipant.update(
        { isActive: false },
        { where: { chatId } }
      );

      // ✅ Soft delete the chat
      await chat.update({ isActive: false });

      const io = getIO(req);
      emitToUsers(io, memberIdsBeforeDelete.filter(id => id !== userId), 'group_removed', {
        chatId, reason: 'deleted', groupName: chat.name
      });
      leaveChatRoom(io, memberIdsBeforeDelete, chatId);

      console.log(`🗑️ Group ${chatId} soft-deleted by admin ${userId}`);
    } else {
      // ✅ For direct chats, mark current user's participant as inactive
      await participant.update({ isActive: false });
      console.log(`🗑️ User ${userId} marked as inactive in chat ${chatId}`);

      // ✅ NEW: Mark all messages in this chat as deleted for this user
      const messages = await Message.findAll({
        where: { chatId },
        attributes: ['id']
      });

      if (messages.length > 0) {
        const messageIds = messages.map(msg => msg.id);
        
        // Create deletion records for all messages (for this user only)
        const deletionRecords = messageIds.map(messageId => ({
          messageId,
          userId,
          deletedAt: new Date()
        }));

        await UserMessageDeletion.bulkCreate(deletionRecords, {
          ignoreDuplicates: true // In case some messages were already deleted
        });

        console.log(`✅ Marked ${messageIds.length} messages as deleted for user ${userId} in chat ${chatId}`);
      }

      // ✅ Check if both participants have left
      const activeParticipants = await ChatParticipant.count({
        where: { chatId, isActive: true }
      });

      // ✅ Only soft-delete chat if BOTH participants have left
      if (activeParticipants === 0) {
        await chat.update({ isActive: false });
        console.log(`🗑️ Chat ${chatId} soft-deleted (both participants left)`);
      } else {
        console.log(`✅ Chat ${chatId} remains active (other participant still active)`);
      }
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

    // ✅ NEW: Mark all messages in this group as deleted for this user
    const messages = await Message.findAll({
      where: { chatId },
      attributes: ['id']
    });

    if (messages.length > 0) {
      const messageIds = messages.map(msg => msg.id);
      
      // Create deletion records for all messages (for this user only)
      const deletionRecords = messageIds.map(messageId => ({
        messageId,
        userId,
        deletedAt: new Date()
      }));

      await UserMessageDeletion.bulkCreate(deletionRecords, {
        ignoreDuplicates: true
      });

      console.log(`✅ Marked ${messageIds.length} messages as deleted for user ${userId} leaving group ${chatId}`);
    }

    // Mark participant as inactive
    await participant.update({ isActive: false, leftAt: new Date() });

    // They keep what they already read, but must not be able to read what comes
    // next: drop their key copies and have the remaining members rotate the key
    const { GroupChatKey } = require('../models');
    await GroupChatKey.destroy({ where: { chatId, userId } });
    await chat.update({ settings: { ...(chat.settings || {}), keyRotationNeeded: true } });

    // If user was admin, check if there are other admins
    if (isAdminRole(participant.role)) {
      const otherAdmins = await ChatParticipant.count({
        where: {
          chatId,
          isActive: true,
          role: { [Op.in]: ['admin', 'moderator'] }
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

    const io = getIO(req);
    leaveChatRoom(io, [userId], chatId);
    const leaver = await User.findByPk(userId, { attributes: ['username'] });
    await postSystemMessage(io, chatId, userId, `${leaver?.username || 'Someone'} left`, { type: 'member_left', userId });
    await broadcastGroupUpdate(io, chatId, [], 'member_left');

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

    // Mute is personal: it lives on this user's participant row, not on the
    // shared chat settings (which would mute the chat for everyone).
    if (muteNotifications !== undefined) {
      await ChatParticipant.update(
        { isMuted: !!muteNotifications, mutedUntil: null },
        { where: { chatId, userId } }
      );
    }

    const currentSettings = chat.settings || {};
    const { muteNotifications: _sharedMute, ...sharedSettings } = currentSettings;
    const newSettings = {
      ...sharedSettings,
      ...(disappearingMessages !== undefined && { disappearingMessages }),
      ...(disappearingMessagesDuration !== undefined && { disappearingMessagesDuration })
    };

    if (disappearingMessages !== undefined || disappearingMessagesDuration !== undefined) {
      await chat.update({ settings: newSettings });
    }

    res.json({
      success: true,
      message: 'Chat settings updated successfully',
      settings: { ...newSettings, muteNotifications: muteNotifications !== undefined ? !!muteNotifications : undefined }
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

    const me = await ChatParticipant.findOne({ where: { chatId, userId } });
    const isMuted = !!me?.isMuted && (!me.mutedUntil || new Date(me.mutedUntil) > new Date());

    res.json({
      success: true,
      settings: {
        allowMembersToAddOthers: false,
        allowMembersToEditGroupInfo: false,
        disappearingMessages: false,
        disappearingMessagesDuration: null,
        ...(chat.settings || {}),
        muteNotifications: isMuted,
        mutedUntil: isMuted ? me.mutedUntil : null
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

// Rotate the group key: a new version for the current members. Old versions are
// kept so earlier messages stay readable; people who left never receive the new
// one. After someone leaves or is removed any member may rotate (the next one to
// send does it automatically); otherwise only admins.
// Body: { encryptedGroupKeys: [{ userId, encryptedKey }], keyVersion }
const rotateGroupKey = async (req, res) => {
  const sequelize = require('../config/database');
  const { GroupChatKey } = require('../models');
  let transaction;
  try {
    const { chatId } = req.params;
    const { encryptedGroupKeys, keyVersion } = req.body || {};
    const userId = req.user.id;

    const participant = await ChatParticipant.findOne({ where: { userId, chatId, isActive: true } });
    if (!participant) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }
    const chat = await Chat.findByPk(chatId);
    if (!chat?.isGroup) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (!chat.settings?.keyRotationNeeded && !isAdminRole(participant.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const current = (await GroupChatKey.max('keyVersion', { where: { chatId } })) || 1;
    const newVersion = current + 1;
    // Someone else rotated first: the client refetches and uses theirs
    if (keyVersion !== undefined && Number(keyVersion) !== newVersion) {
      return res.status(409).json({ error: 'Group key already rotated', code: 'KEY_VERSION_CONFLICT', currentVersion: current });
    }

    // The new key must reach every current member, and nobody else
    const memberIds = await activeMemberIds(chatId);
    const provided = new Map((Array.isArray(encryptedGroupKeys) ? encryptedGroupKeys : [])
      .filter(k => k?.userId && k?.encryptedKey)
      .map(k => [k.userId, k.encryptedKey]));
    const missing = memberIds.filter(id => !provided.has(id));
    const outsiders = [...provided.keys()].filter(id => !memberIds.includes(id));
    if (missing.length > 0 || outsiders.length > 0) {
      return res.status(400).json({ error: 'Key set does not match the current members', code: 'KEY_MEMBERS_MISMATCH', missing, outsiders });
    }

    transaction = await sequelize.transaction();
    for (const [memberId, encryptedKey] of provided) {
      await GroupChatKey.create({ chatId, userId: memberId, encryptedGroupKey: encryptedKey, keyVersion: newVersion }, { transaction });
    }
    const { keyRotationNeeded, ...settings } = chat.settings || {};
    await chat.update({ settings }, { transaction });
    await transaction.commit();
    transaction = null;

    await broadcastGroupUpdate(getIO(req), chatId, [], 'key_rotated');

    res.json({
      success: true,
      message: 'Group key rotated successfully',
      keyVersion: newVersion
    });
  } catch (error) {
    if (transaction) await transaction.rollback();
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