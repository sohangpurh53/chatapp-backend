const { Chat, User, Message, ChatParticipant } = require('../models');

// Real-time fan-out for group changes. Every connected socket joins a
// `user_<id>` room (see socketHandlers.handleConnection), so these reach the
// user on any server instance behind the Redis adapter.

const isAdminRole = (role) => role === 'admin' || role === 'moderator';

const DEFAULT_GROUP_SETTINGS = {
  onlyAdminsCanSend: false,
  allowMembersToEditGroupInfo: false,
  allowMembersToAddOthers: false,
  slowModeSeconds: 0,
};

const SLOW_MODE_OPTIONS = [0, 10, 30, 60, 300, 900];

const groupSettingsOf = (chat) => ({ ...DEFAULT_GROUP_SETTINGS, ...(chat?.settings || {}) });

const getIO = (req) => req?.app?.get('io') || null;

const emitToUsers = (io, userIds, event, payload) => {
  if (!io) return;
  for (const userId of new Set(userIds)) {
    io.to(`user_${userId}`).emit(event, payload);
  }
};

const joinChatRoom = (io, userIds, chatId) => {
  if (!io) return;
  for (const userId of userIds) {
    io.in(`user_${userId}`).socketsJoin(`chat_${chatId}`);
  }
};

const leaveChatRoom = (io, userIds, chatId) => {
  if (!io) return;
  for (const userId of userIds) {
    io.in(`user_${userId}`).socketsLeave(`chat_${chatId}`);
  }
};

const activeMemberIds = async (chatId, transaction) => {
  const rows = await ChatParticipant.findAll({
    where: { chatId, isActive: true },
    attributes: ['userId'],
    transaction,
  });
  return rows.map(r => r.userId);
};

/**
 * Store a plaintext "system" event in the group timeline ("Alex added Sam")
 * and broadcast it like a normal message. Never throws: a failed timeline
 * entry must not fail the admin action that triggered it.
 */
const postSystemMessage = async (io, chatId, actorId, content, event = null) => {
  try {
    const message = await Message.create({
      chatId,
      senderId: actorId,
      content,
      messageType: 'system',
      isEncrypted: false,
      status: 'sent',
      encryptionMetadata: event ? { groupEvent: event } : null,
    });
    await Chat.update({ lastActivityAt: new Date() }, { where: { id: chatId } });

    const complete = await Message.findByPk(message.id, {
      include: [{ model: User, as: 'sender', attributes: ['id', 'username', 'avatar'] }],
    });
    if (io && complete) {
      io.to(`chat_${chatId}`).emit('new_message', complete.toJSON());
    }
    return complete;
  } catch (error) {
    console.error('Failed to post group system message:', error.message);
    return null;
  }
};

/** Tell every current member (plus any extra ids, e.g. a removed user) that the group changed. */
const broadcastGroupUpdate = async (io, chatId, extraUserIds = [], reason = 'updated') => {
  if (!io) return;
  const memberIds = await activeMemberIds(chatId);
  emitToUsers(io, [...memberIds, ...extraUserIds], 'group_updated', { chatId, reason });
};

module.exports = {
  isAdminRole,
  DEFAULT_GROUP_SETTINGS,
  SLOW_MODE_OPTIONS,
  groupSettingsOf,
  getIO,
  emitToUsers,
  joinChatRoom,
  leaveChatRoom,
  activeMemberIds,
  postSystemMessage,
  broadcastGroupUpdate,
};
