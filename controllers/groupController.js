const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Chat, User, ChatParticipant, GroupChatKey } = require('../models');
const {
  isAdminRole,
  SLOW_MODE_OPTIONS,
  groupSettingsOf,
  getIO,
  emitToUsers,
  joinChatRoom,
  leaveChatRoom,
  postSystemMessage,
  broadcastGroupUpdate,
} = require('../services/groupEvents');

const isMutedNow = (participant) =>
  !!participant?.isMuted && (!participant.mutedUntil || new Date(participant.mutedUntil) > new Date());

/** Load a group plus the caller's membership; sends the error response itself when access fails. */
const loadGroupForUser = async (req, res) => {
  const { chatId } = req.params;
  const chat = await Chat.findOne({ where: { id: chatId, isGroup: true, isActive: true } });
  if (!chat) {
    res.status(404).json({ error: 'Group not found' });
    return null;
  }
  const me = await ChatParticipant.findOne({ where: { chatId, userId: req.user.id, isActive: true } });
  if (!me) {
    res.status(403).json({ error: 'You are not a member of this group' });
    return null;
  }
  return { chat, me, settings: groupSettingsOf(chat) };
};

const permissionsFor = (chat, me, settings) => {
  const admin = isAdminRole(me.role);
  return {
    role: me.role,
    isAdmin: admin,
    isOwner: chat.createdBy === me.userId,
    canEditInfo: admin || !!settings.allowMembersToEditGroupInfo,
    canAddMembers: admin || !!settings.allowMembersToAddOthers,
    canSend: admin || !settings.onlyAdminsCanSend,
    isMuted: isMutedNow(me),
    mutedUntil: isMutedNow(me) ? me.mutedUntil : null,
  };
};

const usernamesOf = async (userIds) => {
  const users = await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'username'] });
  const byId = new Map(users.map(u => [u.id, u.username]));
  return userIds.map(id => byId.get(id) || 'someone');
};

const joinNames = (names) => {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

// GET /chat/:chatId/group
const getGroupDetails = async (req, res) => {
  try {
    const ctx = await loadGroupForUser(req, res);
    if (!ctx) return;
    const { chat, me, settings } = ctx;

    const rows = await ChatParticipant.findAll({
      where: { chatId: chat.id, isActive: true },
      include: [{ model: User, as: 'user', attributes: ['id', 'username', 'avatar', 'isOnline', 'email'] }],
      order: [['joinedAt', 'ASC']],
    });

    const members = rows
      .filter(r => r.user)
      .map(r => ({
        id: r.user.id,
        username: r.user.username,
        email: r.user.email,
        avatar: r.user.avatar,
        isOnline: r.user.isOnline,
        role: isAdminRole(r.role) ? 'admin' : 'member',
        isOwner: chat.createdBy === r.userId,
        joinedAt: r.joinedAt,
      }))
      // Owner first, then admins, then members by join date
      .sort((a, b) => (Number(b.isOwner) - Number(a.isOwner))
        || (Number(b.role === 'admin') - Number(a.role === 'admin')));

    const creator = await User.findByPk(chat.createdBy, { attributes: ['id', 'username'] });

    res.json({
      group: {
        id: chat.id,
        name: chat.name,
        description: chat.description,
        avatar: chat.avatar,
        createdAt: chat.createdAt,
        createdBy: chat.createdBy,
        createdByName: creator?.username || null,
      },
      settings: {
        onlyAdminsCanSend: !!settings.onlyAdminsCanSend,
        allowMembersToEditGroupInfo: !!settings.allowMembersToEditGroupInfo,
        allowMembersToAddOthers: !!settings.allowMembersToAddOthers,
        slowModeSeconds: Number(settings.slowModeSeconds) || 0,
        allowAiOnMessages: settings.allowAiOnMessages !== false,
      },
      members,
      me: permissionsFor(chat, me, settings),
      slowModeOptions: SLOW_MODE_OPTIONS,
    });
  } catch (error) {
    console.error('Get group details error:', error);
    res.status(500).json({ error: 'Failed to load group' });
  }
};

// POST /chat/:chatId/members  { members: [{ userId, encryptedGroupKey? }] }
const addMembers = async (req, res) => {
  const io = getIO(req);
  let transaction;
  try {
    const ctx = await loadGroupForUser(req, res);
    if (!ctx) return;
    const { chat, me, settings } = ctx;

    if (!permissionsFor(chat, me, settings).canAddMembers) {
      return res.status(403).json({ error: 'Only admins can add members to this group' });
    }

    const requested = Array.isArray(req.body?.members) ? req.body.members : [];
    const unique = new Map();
    for (const m of requested) {
      if (m && typeof m.userId === 'string' && m.userId !== req.user.id) unique.set(m.userId, m);
    }
    if (unique.size === 0) {
      return res.status(400).json({ error: 'No members to add' });
    }

    const users = await User.findAll({ where: { id: { [Op.in]: [...unique.keys()] } }, attributes: ['id'] });
    const validIds = new Set(users.map(u => u.id));

    const latestKey = await GroupChatKey.findOne({ where: { chatId: chat.id }, order: [['keyVersion', 'DESC']] });
    const keyVersion = latestKey?.keyVersion || 1;

    transaction = await sequelize.transaction();
    const added = [];
    for (const [userId, m] of unique) {
      if (!validIds.has(userId)) continue;

      const existing = await ChatParticipant.findOne({ where: { chatId: chat.id, userId }, transaction });
      if (existing?.isActive) continue;

      if (existing) {
        await existing.update({ isActive: true, role: 'member', joinedAt: new Date(), leftAt: null }, { transaction });
      } else {
        await ChatParticipant.create({ chatId: chat.id, userId, role: 'member', isActive: true }, { transaction });
      }

      // Only a copy of the current key version is useful to a new member
      if (m.encryptedGroupKey && (m.keyVersion === undefined || Number(m.keyVersion) === keyVersion)) {
        await GroupChatKey.destroy({ where: { chatId: chat.id, userId, keyVersion }, transaction });
        await GroupChatKey.create({
          chatId: chat.id,
          userId,
          encryptedGroupKey: m.encryptedGroupKey,
          keyVersion,
        }, { transaction });
      }
      added.push(userId);
    }

    await chat.update({ lastActivityAt: new Date() }, { transaction });
    await transaction.commit();
    transaction = null;

    if (added.length > 0) {
      joinChatRoom(io, added, chat.id);
      const [actorName] = await usernamesOf([req.user.id]);
      const names = await usernamesOf(added);
      await postSystemMessage(io, chat.id, req.user.id, `${actorName} added ${joinNames(names)}`, {
        type: 'members_added', userIds: added,
      });
      emitToUsers(io, added, 'group_added', { chatId: chat.id });
      await broadcastGroupUpdate(io, chat.id, [], 'members_added');
    }

    res.json({ success: true, added, keyVersion });
  } catch (error) {
    if (transaction) await transaction.rollback();
    console.error('Add group members error:', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
};

// DELETE /chat/:chatId/members/:userId
const removeMember = async (req, res) => {
  const io = getIO(req);
  try {
    const ctx = await loadGroupForUser(req, res);
    if (!ctx) return;
    const { chat, me } = ctx;
    const targetId = req.params.userId;

    if (!isAdminRole(me.role)) {
      return res.status(403).json({ error: 'Only admins can remove members' });
    }
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Use "Exit group" to leave the group' });
    }
    if (targetId === chat.createdBy) {
      return res.status(403).json({ error: 'The group owner cannot be removed' });
    }

    const target = await ChatParticipant.findOne({ where: { chatId: chat.id, userId: targetId, isActive: true } });
    if (!target) {
      return res.status(404).json({ error: 'Member not found' });
    }

    await target.update({ isActive: false, leftAt: new Date(), role: 'member' });
    // Without a key row the removed user can no longer fetch the group key, and
    // the next member to send rotates it, so they can't read new messages with
    // the key they already had.
    await GroupChatKey.destroy({ where: { chatId: chat.id, userId: targetId } });
    await chat.update({ settings: { ...(chat.settings || {}), keyRotationNeeded: true } });

    leaveChatRoom(io, [targetId], chat.id);
    emitToUsers(io, [targetId], 'group_removed', { chatId: chat.id, reason: 'removed', groupName: chat.name });

    const [actorName, targetName] = await usernamesOf([req.user.id, targetId]);
    await postSystemMessage(io, chat.id, req.user.id, `${actorName} removed ${targetName}`, {
      type: 'member_removed', userId: targetId,
    });
    await broadcastGroupUpdate(io, chat.id, [], 'member_removed');

    res.json({ success: true });
  } catch (error) {
    console.error('Remove group member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

// PUT /chat/:chatId/members/:userId/role  { role: 'admin' | 'member' }
const updateMemberRole = async (req, res) => {
  const io = getIO(req);
  try {
    const ctx = await loadGroupForUser(req, res);
    if (!ctx) return;
    const { chat, me } = ctx;
    const targetId = req.params.userId;
    const { role } = req.body || {};

    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "admin" or "member"' });
    }
    if (!isAdminRole(me.role)) {
      return res.status(403).json({ error: 'Only admins can change roles' });
    }
    if (targetId === chat.createdBy && role !== 'admin') {
      return res.status(403).json({ error: 'The group owner is always an admin' });
    }

    const target = await ChatParticipant.findOne({ where: { chatId: chat.id, userId: targetId, isActive: true } });
    if (!target) {
      return res.status(404).json({ error: 'Member not found' });
    }
    if ((isAdminRole(target.role) ? 'admin' : 'member') === role) {
      return res.json({ success: true, unchanged: true });
    }

    // Never leave a group without an admin
    if (role === 'member') {
      const admins = await ChatParticipant.count({
        where: { chatId: chat.id, isActive: true, role: { [Op.in]: ['admin', 'moderator'] } },
      });
      if (admins <= 1) {
        return res.status(400).json({ error: 'A group needs at least one admin' });
      }
    }

    await target.update({ role });

    const [actorName, targetName] = await usernamesOf([req.user.id, targetId]);
    const text = role === 'admin'
      ? `${actorName} made ${targetName} an admin`
      : `${actorName} dismissed ${targetName} as admin`;
    await postSystemMessage(io, chat.id, req.user.id, text, { type: 'role_changed', userId: targetId, role });
    await broadcastGroupUpdate(io, chat.id, [], 'role_changed');

    res.json({ success: true, role });
  } catch (error) {
    console.error('Update member role error:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
};

const describeSlowMode = (seconds) => {
  if (!seconds) return 'off';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
};

// PUT /chat/:chatId/group-settings
const updateGroupSettings = async (req, res) => {
  const io = getIO(req);
  try {
    const ctx = await loadGroupForUser(req, res);
    if (!ctx) return;
    const { chat, me, settings } = ctx;

    if (!isAdminRole(me.role)) {
      return res.status(403).json({ error: 'Only admins can change group settings' });
    }

    const body = req.body || {};
    const next = { ...settings };
    for (const key of ['onlyAdminsCanSend', 'allowMembersToEditGroupInfo', 'allowMembersToAddOthers', 'allowAiOnMessages']) {
      if (typeof body[key] === 'boolean') next[key] = body[key];
    }
    if (body.slowModeSeconds !== undefined) {
      const seconds = Number(body.slowModeSeconds);
      if (!SLOW_MODE_OPTIONS.includes(seconds)) {
        return res.status(400).json({ error: 'Unsupported slow mode interval' });
      }
      next.slowModeSeconds = seconds;
    }

    await chat.update({ settings: next });

    const [actorName] = await usernamesOf([req.user.id]);
    if (!!next.onlyAdminsCanSend !== !!settings.onlyAdminsCanSend) {
      await postSystemMessage(io, chat.id, req.user.id, next.onlyAdminsCanSend
        ? `${actorName} turned on announcement mode. Only admins can send messages`
        : `${actorName} turned off announcement mode. Everyone can send messages`,
      { type: 'settings_changed', key: 'onlyAdminsCanSend' });
    }
    if ((Number(next.slowModeSeconds) || 0) !== (Number(settings.slowModeSeconds) || 0)) {
      await postSystemMessage(io, chat.id, req.user.id, next.slowModeSeconds
        ? `${actorName} set slow mode to ${describeSlowMode(next.slowModeSeconds)}`
        : `${actorName} turned off slow mode`,
      { type: 'settings_changed', key: 'slowModeSeconds' });
    }
    if ((next.allowAiOnMessages !== false) !== (settings.allowAiOnMessages !== false)) {
      await postSystemMessage(io, chat.id, req.user.id, next.allowAiOnMessages === false
        ? `${actorName} turned off AI features for this group's messages`
        : `${actorName} allowed AI features on this group's messages`,
      { type: 'settings_changed', key: 'allowAiOnMessages' });
    }
    await broadcastGroupUpdate(io, chat.id, [], 'settings_changed');

    res.json({ success: true, settings: next });
  } catch (error) {
    console.error('Update group settings error:', error);
    res.status(500).json({ error: 'Failed to update group settings' });
  }
};

// PUT /chat/:chatId/mute  { mute: boolean, hours?: number }  (per-user, not shared)
const muteGroup = async (req, res) => {
  try {
    const { chatId } = req.params;
    const me = await ChatParticipant.findOne({ where: { chatId, userId: req.user.id, isActive: true } });
    if (!me) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { mute, hours } = req.body || {};
    const mutedUntil = mute && Number(hours) > 0 ? new Date(Date.now() + Number(hours) * 3600 * 1000) : null;
    await me.update({ isMuted: !!mute, mutedUntil });
    res.json({ success: true, isMuted: !!mute, mutedUntil });
  } catch (error) {
    console.error('Mute group error:', error);
    res.status(500).json({ error: 'Failed to update mute' });
  }
};

module.exports = {
  getGroupDetails,
  addMembers,
  removeMember,
  updateMemberRole,
  updateGroupSettings,
  muteGroup,
  isMutedNow,
};
