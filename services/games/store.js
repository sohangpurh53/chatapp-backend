// Database access for game sessions. The engine works on plain objects with
// times in epoch milliseconds; this maps them to rows. Every change runs inside
// a transaction holding the row lock, so two servers (or two taps) can never
// apply conflicting moves to the same session.
const { Op } = require('sequelize');
const { sequelize, Chat, ChatParticipant, User, GameSession, GameResult, GameChallenge, CustomGame } = require('../../models');

const ms = (value) => (value ? new Date(value).getTime() : null);
const date = (value) => (value ? new Date(value) : null);

const toSession = (row) => {
  if (!row) return null;
  const r = row.get ? row.get({ plain: true }) : row;
  return {
    id: r.id,
    chatId: r.chatId,
    gameType: r.gameType,
    direct: !!r.direct,
    hostId: r.hostId,
    createdBy: r.createdBy,
    status: r.status,
    endReason: r.endReason || null,
    players: r.players || [],
    state: r.state || null,
    version: r.version,
    createdAt: ms(r.createdAt),
    startedAt: ms(r.startedAt),
    endedAt: ms(r.endedAt),
    deadline: ms(r.deadline),
    rematchOfId: r.rematchOfId || null,
    content: r.content || null,
    challenge: r.challenge || null,
    cardMessageId: r.cardMessageId || null,
    resultMessageId: r.resultMessageId || null,
  };
};

const toRow = (s) => ({
  hostId: s.hostId,
  status: s.status,
  endReason: s.endReason,
  players: s.players,
  state: s.state,
  version: s.version,
  deadline: date(s.deadline),
  startedAt: date(s.startedAt),
  endedAt: date(s.endedAt),
  cardMessageId: s.cardMessageId || null,
  resultMessageId: s.resultMessageId || null,
});

const OPEN_STATUSES = ['lobby', 'active'];

const dbStore = {
  async create(session) {
    const row = await GameSession.create({
      id: session.id,
      chatId: session.chatId,
      gameType: session.gameType,
      direct: session.direct,
      createdBy: session.createdBy,
      rematchOfId: session.rematchOfId,
      content: session.content,
      challengeId: session.challenge?.id || null,
      challenge: session.challenge,
      ...toRow(session),
    });
    return toSession(row);
  },

  async get(id) {
    return toSession(await GameSession.findByPk(id));
  },

  async findOpen(chatId) {
    return toSession(await GameSession.findOne({
      // Solo challenge rounds don't take up the chat's one open game
      where: { chatId, status: { [Op.in]: OPEN_STATUSES }, challengeId: null },
      order: [['createdAt', 'DESC']],
    }));
  },

  /**
   * Runs `change(session)` under the row lock. `change` returns the next
   * session, or the same object when nothing changed (then nothing is written).
   * Resolves to { before, after }, or null when the session doesn't exist.
   */
  async update(id, change) {
    return sequelize.transaction(async (transaction) => {
      const row = await GameSession.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row) return null;
      const before = toSession(row);
      const after = await change(before);
      if (after && after !== before) {
        await row.update(toRow(after), { transaction });
      }
      return { before, after: after || before };
    });
  },

  async markSettled(id) {
    await GameSession.update({ settledAt: new Date() }, { where: { id } });
  },

  /** Ended before `before`, with results or cards possibly still to write. */
  async findUnsettled(before, limit = 20) {
    const rows = await GameSession.findAll({
      where: { status: { [Op.notIn]: OPEN_STATUSES }, settledAt: null, endedAt: { [Op.lte]: new Date(before) } },
      limit,
    });
    return rows.map(toSession);
  },

  /** Open sessions whose clock should already have moved them on. */
  async findDue(now, limit = 50) {
    const rows = await GameSession.findAll({
      where: { status: { [Op.in]: OPEN_STATUSES }, deadline: { [Op.lte]: new Date(now) } },
      attributes: ['id'],
      limit,
    });
    return rows.map(r => r.id);
  },

  async saveResults(rows) {
    if (!rows.length) return;
    await GameResult.bulkCreate(rows.map(r => ({ ...r, completedAt: new Date(r.completedAt) })), { ignoreDuplicates: true });
  },

  // ---------- challenges ----------

  async createChallenge(values) {
    return (await GameChallenge.create(values)).get({ plain: true });
  },

  async getChallenge(id) {
    const row = await GameChallenge.findByPk(id);
    return row ? row.get({ plain: true }) : null;
  },

  /** This person's challenge still waiting in the chat, if any. */
  async findPendingChallenge(chatId, challengerId) {
    const row = await GameChallenge.findOne({ where: { chatId, challengerId, status: 'pending' } });
    return row ? row.get({ plain: true }) : null;
  },

  async hasChallengeFrom(sourceSessionId, challengerId) {
    return (await GameChallenge.count({ where: { sourceSessionId, challengerId } })) > 0;
  },

  /** Same contract as update(): `change` returns new values, or null for no change. */
  async updateChallenge(id, change) {
    return sequelize.transaction(async (transaction) => {
      const row = await GameChallenge.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row) return null;
      const values = await change(row.get({ plain: true }));
      if (values) await row.update(values, { transaction });
      return row.get({ plain: true });
    });
  },

  async findExpiredChallengeIds(now, limit = 50) {
    const rows = await GameChallenge.findAll({
      where: { status: { [Op.in]: ['pending', 'accepted'] }, expiresAt: { [Op.lte]: new Date(now) } },
      attributes: ['id'],
      limit,
    });
    return rows.map(r => r.id);
  },

  // ---------- stats ----------

  async userResults(userId, limit = 500) {
    const rows = await GameResult.findAll({ where: { userId }, order: [['completedAt', 'DESC']], limit });
    return rows.map(r => r.get({ plain: true }));
  },

  async chatResults(chatId) {
    const rows = await GameResult.findAll({ where: { chatId }, attributes: ['userId', 'score', 'won', 'playerCount'] });
    return rows.map(r => r.get({ plain: true }));
  },

  async challengeCounts(userId) {
    const [challengesCompleted, challengesWon] = await Promise.all([
      GameChallenge.count({ where: { takerId: userId, status: 'completed' } }),
      GameChallenge.count({ where: { takerId: userId, status: 'completed', beat: true } }),
    ]);
    return { challengesCompleted, challengesWon };
  },

  /** { chatId: display name } for the chats this user is still in. */
  async chatLabels(userId, chatIds) {
    if (!chatIds.length) return {};
    const memberships = await ChatParticipant.findAll({ where: { userId, chatId: chatIds, isActive: true }, attributes: ['chatId'] });
    const chats = await Chat.findAll({
      where: { id: memberships.map(m => m.chatId) },
      attributes: ['id', 'isGroup', 'name', 'participant1Id', 'participant2Id'],
    });
    const peerId = (chat) => (chat.participant1Id === userId ? chat.participant2Id : chat.participant1Id);
    const peers = await User.findAll({
      where: { id: chats.filter(c => !c.isGroup).map(peerId) },
      attributes: ['id', 'username'],
    });
    const nameOf = new Map(peers.map(p => [p.id, p.username]));
    return Object.fromEntries(chats.map(c => [c.id, c.isGroup ? c.name : nameOf.get(peerId(c)) || 'Chat']));
  },

  /** Active members who haven't opted out of leaderboards. */
  async leaderboardMembers(chatId) {
    const rows = await ChatParticipant.findAll({
      where: { chatId, isActive: true },
      attributes: ['userId'],
      include: [{ model: User, as: 'user', attributes: ['id', 'username', 'notificationPreferences'] }],
    });
    return rows
      .filter(r => r.user && r.user.notificationPreferences?.showGameStats !== false)
      .map(r => ({ userId: r.userId, username: r.user.username }));
  },

  // Saved custom games: every lookup is by owner, so ids can't reach someone else's
  async getCustomGame(id, userId) {
    const row = await CustomGame.findOne({ where: { id, userId } });
    return row ? row.get({ plain: true }) : null;
  },

  async listCustomGames(userId) {
    const rows = await CustomGame.findAll({ where: { userId }, order: [['updatedAt', 'DESC']] });
    return rows.map(r => r.get({ plain: true }));
  },

  countCustomGames(userId) {
    return CustomGame.count({ where: { userId } });
  },

  async createCustomGame(userId, game) {
    return (await CustomGame.create({ ...game, userId })).get({ plain: true });
  },

  async updateCustomGame(id, userId, game) {
    const row = await CustomGame.findOne({ where: { id, userId } });
    if (!row) return null;
    return (await row.update(game)).get({ plain: true });
  },

  async deleteCustomGame(id, userId) {
    return (await CustomGame.destroy({ where: { id, userId } })) > 0;
  },
};

module.exports = { dbStore, toSession, toRow };
