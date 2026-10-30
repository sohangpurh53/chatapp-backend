// An in-memory stand-in for the game tables and the chat rows the games code
// reads, so game tests run the real service and sockets without a database.
const { randomUUID } = require('node:crypto');
const { Chat, User, Message, ChatParticipant, UserBlock } = require('../../models');
const redisService = require('../../config/redis');

const copy = (value) => JSON.parse(JSON.stringify(value));

/** Same contract as services/games/store dbStore. */
function memoryStore() {
  const sessions = new Map();
  const results = [];
  const customGames = new Map();
  const challenges = new Map();
  const leftChats = new Set();
  const boardMembers = [];
  const settled = new Set();
  return {
    challenges,
    leftChats,
    boardMembers,
    settled,
    sessions,
    results,
    customGames,
    async create(session) {
      if (!session.challenge && [...sessions.values()].some(s => s.chatId === session.chatId && !s.challenge && (s.status === 'lobby' || s.status === 'active'))) {
        throw Object.assign(new Error('unique'), { name: 'SequelizeUniqueConstraintError' });
      }
      sessions.set(session.id, copy(session));
      return copy(session);
    },
    async get(id) {
      return sessions.has(id) ? copy(sessions.get(id)) : null;
    },
    async findOpen(chatId) {
      const open = [...sessions.values()].filter(s => s.chatId === chatId && !s.challenge && (s.status === 'lobby' || s.status === 'active'));
      return open.length ? copy(open[open.length - 1]) : null;
    },
    async update(id, change) {
      if (!sessions.has(id)) return null;
      const before = copy(sessions.get(id));
      const after = await change(before);
      if (after && after !== before) sessions.set(id, copy(after));
      return { before, after: after || before };
    },
    async findDue(now) {
      return [...sessions.values()]
        .filter(s => (s.status === 'lobby' || s.status === 'active') && s.deadline && s.deadline <= now)
        .map(s => s.id);
    },
    async markSettled(id) {
      settled.add(id);
    },
    async findUnsettled(before) {
      return [...sessions.values()]
        .filter(s => s.status !== 'lobby' && s.status !== 'active' && !settled.has(s.id) && s.endedAt <= before)
        .map(copy);
    },
    async hasChallengeFrom(sourceSessionId, challengerId) {
      return [...challenges.values()].some(c => c.sourceSessionId === sourceSessionId && c.challengerId === challengerId);
    },
    async createChallenge(values) {
      challenges.set(values.id, copy(values));
      return copy(values);
    },
    async getChallenge(id) {
      return challenges.has(id) ? copy(challenges.get(id)) : null;
    },
    async findPendingChallenge(chatId, challengerId) {
      const found = [...challenges.values()].find(c => c.chatId === chatId && c.challengerId === challengerId && c.status === 'pending');
      return found ? copy(found) : null;
    },
    async updateChallenge(id, change) {
      if (!challenges.has(id)) return null;
      const values = await change(copy(challenges.get(id)));
      if (values) challenges.set(id, { ...challenges.get(id), ...values });
      return copy(challenges.get(id));
    },
    async findExpiredChallengeIds(now) {
      return [...challenges.values()].filter(c => ['pending', 'accepted'].includes(c.status) && new Date(c.expiresAt).getTime() <= now).map(c => c.id);
    },
    async userResults(userId) {
      return results.filter(r => r.userId === userId).reverse().map(copy);
    },
    async chatResults(chatId) {
      return results.filter(r => r.chatId === chatId).map(copy);
    },
    async challengeCounts(userId) {
      const done = [...challenges.values()].filter(c => c.takerId === userId && c.status === 'completed');
      return { challengesCompleted: done.length, challengesWon: done.filter(c => c.beat).length };
    },
    async chatLabels(userId, chatIds) {
      return Object.fromEntries(chatIds.filter(id => !leftChats.has(id)).map(id => [id, `Chat ${id.slice(0, 4)}`]));
    },
    async leaderboardMembers() {
      return [...boardMembers];
    },
    async getCustomGame(id, userId) {
      const game = customGames.get(id);
      return game && game.userId === userId ? copy(game) : null;
    },
    async listCustomGames(userId) {
      return [...customGames.values()].filter(g => g.userId === userId).map(copy);
    },
    async countCustomGames(userId) {
      return [...customGames.values()].filter(g => g.userId === userId).length;
    },
    async createCustomGame(userId, game) {
      const row = { ...copy(game), id: randomUUID(), userId };
      customGames.set(row.id, row);
      return copy(row);
    },
    async updateCustomGame(id, userId, game) {
      if (customGames.get(id)?.userId !== userId) return null;
      customGames.set(id, { ...customGames.get(id), ...copy(game) });
      return copy(customGames.get(id));
    },
    async deleteCustomGame(id, userId) {
      if (customGames.get(id)?.userId !== userId) return false;
      return customGames.delete(id);
    },
    async saveResults(rows) {
      for (const row of rows) {
        if (!results.some(r => r.sessionId === row.sessionId && r.userId === row.userId)) results.push(row);
      }
    },
  };
}

/**
 * Chats as { id, isGroup, members: [userId], participant1Id?, participant2Id? }.
 * Stubs the model calls the games code makes; `blocks` is [[blockerId, blockedId]].
 */
function installChatWorld({ chats, blocks = [] }) {
  const messages = new Map();
  const online = new Set();
  const claims = new Set();
  const originals = [];
  const stub = (object, name, replacement) => {
    originals.push([object, name, object[name]]);
    object[name] = replacement;
  };
  const chatById = (id) => chats.find(c => c.id === id) || null;
  const row = (data) => ({ ...data, toJSON: () => ({ ...data }), get: () => ({ ...data }) });

  stub(ChatParticipant, 'findOne', async ({ where }) => {
    const chat = chatById(where.chatId);
    return chat && chat.members.includes(where.userId) ? { userId: where.userId, chatId: chat.id, role: 'member' } : null;
  });
  stub(ChatParticipant, 'findAll', async ({ where }) => {
    const chat = chatById(where.chatId);
    const ids = [].concat(where.userId || []);
    return (chat ? chat.members : [])
      .filter(id => ids.length === 0 || ids.includes(id))
      .map(id => ({ userId: id, isMuted: (chat.muted || []).includes(id), user: { id, username: id, avatar: null } }));
  });
  stub(Chat, 'findByPk', async (id) => {
    const chat = chatById(id);
    return chat ? { isActive: true, ...chat } : null;
  });
  // Socket rooms on connect (socketHandlers.joinUserChats)
  stub(Chat, 'findAll', async (options) => {
    const userId = options?.include?.[0]?.where?.id;
    return chats.filter(c => c.members.includes(userId)).map(c => ({ id: c.id }));
  });
  stub(Chat, 'update', async () => [1]);
  stub(Chat, 'findOne', async ({ where }) => {
    const pairs = where[Object.getOwnPropertySymbols(where)[0]];
    return chats.find(c => !c.isGroup && pairs.some(p => p.participant1Id === c.participant1Id && p.participant2Id === c.participant2Id)) || null;
  });
  stub(User, 'findByPk', async (id) => ({ id, username: id, avatar: null }));
  stub(UserBlock, 'findAll', async ({ where }) => {
    const pairs = where[Object.getOwnPropertySymbols(where)[0]] || [];
    return blocks
      .filter(([blockerId, blockedId]) => pairs.some(p => p.blockerId === blockerId && p.blockedId === blockedId))
      .map(([blockerId, blockedId]) => ({ blockerId, blockedId }));
  });
  // Push decisions: who is online, and the once-per-window claim
  stub(redisService, 'getUserOnlineStatus', async (id) => online.has(id));
  stub(redisService, 'claimOnce', async (key) => {
    if (claims.has(key)) return false;
    claims.add(key);
    return true;
  });
  stub(Message, 'findOrCreate', async ({ where, defaults }) => {
    if (messages.has(where.id)) return [row(messages.get(where.id)), false];
    messages.set(where.id, { ...defaults, createdAt: new Date() });
    return [row(messages.get(where.id)), true];
  });
  stub(Message, 'create', async (values) => {
    messages.set(values.id, { ...values, createdAt: new Date() });
    return row(messages.get(values.id));
  });
  stub(Message, 'findByPk', async (id) => (messages.has(id) ? row(messages.get(id)) : null));
  stub(Message, 'update', async (values, { where }) => {
    if (!messages.has(where.id)) return [0];
    messages.set(where.id, { ...messages.get(where.id), ...values });
    return [1];
  });

  return {
    messages,
    online,
    claims,
    restore() {
      while (originals.length) {
        const [object, name, original] = originals.pop();
        object[name] = original;
      }
    },
  };
}

module.exports = { memoryStore, installChatWorld };
