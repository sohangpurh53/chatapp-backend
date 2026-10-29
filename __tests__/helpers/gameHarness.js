// An in-memory stand-in for the game tables and the chat rows the games code
// reads, so game tests run the real service and sockets without a database.
const { Chat, User, Message, ChatParticipant, UserBlock } = require('../../models');

const copy = (value) => JSON.parse(JSON.stringify(value));

/** Same contract as services/games/store dbStore. */
function memoryStore() {
  const sessions = new Map();
  const results = [];
  return {
    sessions,
    results,
    async create(session) {
      sessions.set(session.id, copy(session));
      return copy(session);
    },
    async get(id) {
      return sessions.has(id) ? copy(sessions.get(id)) : null;
    },
    async findOpen(chatId) {
      const open = [...sessions.values()].filter(s => s.chatId === chatId && (s.status === 'lobby' || s.status === 'active'));
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
      .map(id => ({ userId: id, user: { id, username: id, avatar: null } }));
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
  stub(User, 'findByPk', async (id) => ({ id, username: id, avatar: null }));
  stub(UserBlock, 'findAll', async ({ where }) => {
    const pairs = where[Object.getOwnPropertySymbols(where)[0]] || [];
    return blocks
      .filter(([blockerId, blockedId]) => pairs.some(p => p.blockerId === blockerId && p.blockedId === blockedId))
      .map(([blockerId, blockedId]) => ({ blockerId, blockedId }));
  });
  stub(Message, 'findOrCreate', async ({ where, defaults }) => {
    if (messages.has(where.id)) return [row(messages.get(where.id)), false];
    messages.set(where.id, { ...defaults, createdAt: new Date() });
    return [row(messages.get(where.id)), true];
  });
  stub(Message, 'findByPk', async (id) => (messages.has(id) ? row(messages.get(id)) : null));
  stub(Message, 'update', async (values, { where }) => {
    if (!messages.has(where.id)) return [0];
    messages.set(where.id, { ...messages.get(where.id), ...values });
    return [1];
  });

  return {
    messages,
    restore() {
      while (originals.length) {
        const [object, name, original] = originals.pop();
        object[name] = original;
      }
    },
  };
}

module.exports = { memoryStore, installChatWorld };
