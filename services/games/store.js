// Database access for game sessions. The engine works on plain objects with
// times in epoch milliseconds; this maps them to rows. Every change runs inside
// a transaction holding the row lock, so two servers (or two taps) can never
// apply conflicting moves to the same session.
const { Op } = require('sequelize');
const { sequelize, GameSession, GameResult, CustomGame } = require('../../models');

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
      ...toRow(session),
    });
    return toSession(row);
  },

  async get(id) {
    return toSession(await GameSession.findByPk(id));
  },

  async findOpen(chatId) {
    return toSession(await GameSession.findOne({
      where: { chatId, status: { [Op.in]: OPEN_STATUSES } },
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
