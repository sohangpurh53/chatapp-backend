const { Op } = require('sequelize');
const { User } = require('../models');

// Read receipts follow the WhatsApp rule: a user who turns them off doesn't
// send "read" to others and doesn't see "read" from others. Receipts are still
// stored, so the user's own unread counts keep working.

const hasReadReceiptsOff = (user) => user?.notificationPreferences?.readReceipts === false;

/** Ids (from the given list) of users who turned read receipts off. */
const usersWithReadReceiptsOff = async (userIds) => {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const users = await User.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ['id', 'notificationPreferences'],
  });
  return new Set(users.filter(hasReadReceiptsOff).map(u => u.id));
};

const readReceiptsEnabled = async (userId) => {
  const user = await User.findByPk(userId, { attributes: ['notificationPreferences'] });
  return !hasReadReceiptsOff(user);
};

/**
 * Downgrade "read" receipts to "delivered" in plain message objects for a
 * viewer, where either the reader or the viewer has read receipts off.
 */
const maskReadReceipts = async (messages, viewerId) => {
  const readerIds = [];
  for (const message of messages) {
    for (const receipt of message.receipts || []) {
      if (receipt.status === 'read' && receipt.userId !== viewerId) readerIds.push(receipt.userId);
    }
  }
  if (readerIds.length === 0) return messages;

  const hidden = await usersWithReadReceiptsOff([...readerIds, viewerId]);
  if (hidden.size === 0) return messages;
  const viewerHidesAll = hidden.has(viewerId);

  for (const message of messages) {
    for (const receipt of message.receipts || []) {
      if (receipt.status === 'read' && receipt.userId !== viewerId && (viewerHidesAll || hidden.has(receipt.userId))) {
        receipt.status = 'delivered';
      }
    }
  }
  return messages;
};

module.exports = { readReceiptsEnabled, usersWithReadReceiptsOff, maskReadReceipts };
