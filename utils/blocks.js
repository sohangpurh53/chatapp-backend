const { Op } = require('sequelize');
const { UserBlock } = require('../models');

// Blocking is symmetric in effect: if either user blocked the other, neither can
// message or call the other.
const isBlockedEitherWay = async (userA, userB) => {
  if (!userA || !userB) return false;
  const row = await UserBlock.findOne({
    where: {
      [Op.or]: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA }
      ]
    },
    attributes: ['id']
  });
  return !!row;
};

// Which direction, for screens that show "Unblock" only to the person who blocked
const blockState = async (viewerId, otherId) => {
  const rows = await UserBlock.findAll({
    where: {
      [Op.or]: [
        { blockerId: viewerId, blockedId: otherId },
        { blockerId: otherId, blockedId: viewerId }
      ]
    },
    attributes: ['blockerId']
  });
  return {
    blockedByMe: rows.some(r => r.blockerId === viewerId),
    blockedByThem: rows.some(r => r.blockerId === otherId)
  };
};

// Everyone the user can't talk to, in either direction
const blockedPeerIds = async (userId) => {
  const rows = await UserBlock.findAll({
    where: { [Op.or]: [{ blockerId: userId }, { blockedId: userId }] },
    attributes: ['blockerId', 'blockedId']
  });
  return [...new Set(rows.map(r => (r.blockerId === userId ? r.blockedId : r.blockerId)))];
};

// People this user blocked (not the ones who blocked them: that stays unknown to them)
const blockedByUser = async (userId) => {
  const rows = await UserBlock.findAll({ where: { blockerId: userId }, attributes: ['blockedId'] });
  return rows.map(r => r.blockedId);
};

// The other member of a 1:1 chat, or null for groups
const directPeerId = (chat, userId) => {
  if (!chat || chat.isGroup) return null;
  if (chat.participant1Id === userId) return chat.participant2Id;
  if (chat.participant2Id === userId) return chat.participant1Id;
  return null;
};

module.exports = { isBlockedEitherWay, blockState, blockedPeerIds, blockedByUser, directPeerId };
