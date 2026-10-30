const { User, UserBlock } = require('../models');

const blockUser = async (req, res) => {
  try {
    const blockerId = req.user.id;
    const { userId: blockedId } = req.params;

    if (blockedId === blockerId) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }
    const target = await User.findByPk(blockedId, { attributes: ['id'] });
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    await UserBlock.findOrCreate({ where: { blockerId, blockedId }, defaults: { blockerId, blockedId } });
    require('../services/games').pairBlocked(blockerId, blockedId).catch(error => console.error('Game update failed:', error.message));
    res.json({ success: true, blocked: true });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const unblockUser = async (req, res) => {
  try {
    await UserBlock.destroy({ where: { blockerId: req.user.id, blockedId: req.params.userId } });
    res.json({ success: true, blocked: false });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Only the people the caller blocked; who blocked the caller is never revealed
const listBlockedUsers = async (req, res) => {
  try {
    const rows = await UserBlock.findAll({
      where: { blockerId: req.user.id },
      include: [{ model: User, as: 'blocked', attributes: ['id', 'username', 'avatar'] }],
      order: [['createdAt', 'DESC']]
    });
    res.json({
      users: rows.filter(r => r.blocked).map(r => ({
        id: r.blocked.id,
        username: r.blocked.username,
        avatar: r.blocked.avatar,
        blockedAt: r.createdAt
      }))
    });
  } catch (error) {
    console.error('List blocked users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { blockUser, unblockUser, listBlockedUsers };
