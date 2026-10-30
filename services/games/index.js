// In-chat games: who may do what, the session clock, and the cards each game
// leaves in the conversation. The rules themselves live in ./engine.
//
// Realtime: every change is broadcast as 'game_state' (a member's view, see
// engine.viewFor) to the chat_<id> room, and the invite card is kept current
// with 'game_card_updated'. Apps that were away fetch the session again
// (GET /api/games/sessions/:id), so nothing depends on a missed event.
const { v4: uuidv4 } = require('uuid');
const { Chat, User, Message, ChatParticipant } = require('../../models');
const redisService = require('../../config/redis');
const { isUuid } = require('../../utils/ids');
const { blockedPeerIds, blockState, directPeerId } = require('../../utils/blocks');
const engine = require('./engine');
const { getGame, isAvailable, publicCatalog } = require('./catalog');
const { FORMATS, LIMITS, toSessionContent, validateGame } = require('./customGames');
const { GameError } = require('./errors');
const { dbStore } = require('./store');

const CREATE_COOLDOWN_MS = 5000;
const SWEEP_INTERVAL_MS = 15000;
// However often a chat starts games, one person gets one push about them per window
const INVITE_PUSH_WINDOW_SECONDS = 30 * 60;
// Fires a moment after the deadline so the session is due when the timer runs
const TIMER_SLACK_MS = 25;

const userSummary = (user) => ({ id: user.id, username: user.username || null, avatar: user.avatar || null });

const names = (players) => {
  const list = players.map(p => p.username || 'Someone');
  if (list.length <= 2) return list.join(' and ');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

/** The plaintext line chat lists and notifications show for a game card. */
const cardText = (card) => {
  if (card.kind === 'result') {
    const winners = card.players.filter(p => card.winnerIds.includes(p.userId));
    if (!card.scored) return `🎮 ${card.gameName} is over. See how everyone answered.`;
    if (winners.length === 0) return `🎮 ${card.gameName} results`;
    if (winners.length === 1) return `🏆 ${names(winners)} won ${card.gameName}`;
    return `🏆 ${names(winners)} tied in ${card.gameName}`;
  }
  const host = card.players.find(p => p.userId === card.createdBy);
  switch (card.status) {
    case 'lobby': return `🎮 ${host?.username || 'Someone'} started ${card.gameName}. Join in!`;
    case 'active': return `🎮 ${card.gameName} is being played`;
    case 'completed': return `🎮 ${card.gameName} finished`;
    case 'abandoned': return `🎮 ${card.gameName} ended early`;
    default: return `🎮 ${card.gameName} was cancelled`;
  }
};

class GameService {
  constructor({ store = dbStore, now = () => Date.now(), rng = Math.random } = {}) {
    this.store = store;
    this.now = now;
    this.rng = rng;
    this.io = null;
    this.timers = new Map(); // sessionId -> timeout for its next deadline
    this.locks = new Map(); // sessionId -> promise of the last queued task
    this.lastCreateAt = new Map(); // userId -> timestamp (rate limit)
    this.sweeper = null;
  }

  setIO(io) {
    this.io = io;
  }

  catalog() {
    return publicCatalog();
  }

  // ---------- access ----------

  /**
   * The user must be an active member of the chat, and in a 1:1 chat neither
   * person may have blocked the other. Checked on every call, so leaving or
   * being removed from a group cuts off its games at once.
   */
  async authorize(userId, chatId) {
    if (!isUuid(chatId)) throw new GameError('INVALID_REQUEST');
    const participant = await ChatParticipant.findOne({ where: { userId, chatId, isActive: true } });
    if (!participant) throw new GameError('ACCESS_DENIED');
    const chat = await Chat.findByPk(chatId);
    if (!chat || chat.isActive === false) throw new GameError('ACCESS_DENIED');

    const peerId = directPeerId(chat, userId);
    if (peerId) {
      const { blockedByMe, blockedByThem } = await blockState(userId, peerId);
      if (blockedByMe) throw new GameError('USER_BLOCKED');
      // Not told apart from any other reason: the blocked person isn't told
      if (blockedByThem) throw new GameError('GAME_UNAVAILABLE');
    }
    return { chat, peerId };
  }

  async loadAuthorized(userId, sessionId) {
    if (!isUuid(sessionId)) throw new GameError('INVALID_REQUEST');
    const session = await this.store.get(sessionId);
    if (!session) throw new GameError('SESSION_NOT_FOUND');
    // A member of another chat gets the same answer as for a session that doesn't exist
    try {
      await this.authorize(userId, session.chatId);
    } catch (error) {
      if (error.code === 'ACCESS_DENIED') throw new GameError('SESSION_NOT_FOUND');
      throw error;
    }
    return session;
  }

  // ---------- commands ----------

  /**
   * Starts a lobby in the chat and posts its invite card. A chat runs one game
   * at a time: if one is already open, that one is returned instead.
   * `rematchOf` re-invites the players of an earlier session in the same chat.
   */
  async create(userId, { chatId, gameType, rematchOf, customGameId } = {}) {
    // A saved custom game decides its own rules; a rematch brings its content along
    let customContent = null;
    if (customGameId !== undefined && customGameId !== null) {
      if (!isUuid(customGameId)) throw new GameError('INVALID_REQUEST');
      const saved = await this.store.getCustomGame(customGameId, userId);
      if (!saved) throw new GameError('GAME_NOT_FOUND');
      gameType = FORMATS[saved.format];
      customContent = toSessionContent(saved);
    } else if (getGame(gameType)?.custom && !rematchOf) {
      throw new GameError('UNKNOWN_GAME');
    }
    if (typeof gameType !== 'string' || !isAvailable(gameType)) throw new GameError('UNKNOWN_GAME');
    const { chat, peerId } = await this.authorize(userId, chatId);

    const open = await this.store.findOpen(chatId);
    if (open) {
      const current = await this.tick(open.id);
      if (current && engine.isOpen(current)) {
        return { session: engine.viewFor(current, userId, this.now()), existing: true };
      }
    }

    const now = this.now();
    if (now - (this.lastCreateAt.get(userId) || 0) < CREATE_COOLDOWN_MS) throw new GameError('RATE_LIMITED');
    this.lastCreateAt.set(userId, now);

    const host = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });
    if (!host) throw new GameError('ACCESS_DENIED');

    let previous = null;
    if (rematchOf !== undefined && rematchOf !== null) {
      if (!isUuid(rematchOf)) throw new GameError('INVALID_REQUEST');
      previous = await this.store.get(rematchOf);
      if (!previous || previous.chatId !== chatId) throw new GameError('SESSION_NOT_FOUND');
    }

    const inviteeIds = new Set();
    if (peerId) inviteeIds.add(peerId);
    if (previous) previous.players.filter(p => p.playing).forEach(p => inviteeIds.add(p.userId));
    inviteeIds.delete(userId);
    const invitees = await this.activeUsers(chatId, [...inviteeIds]);

    const session = engine.createSession({
      id: uuidv4(),
      chatId,
      gameType: previous ? previous.gameType : gameType,
      host: userSummary(host),
      invitees,
      direct: !!peerId,
      now,
      rematchOfId: previous ? previous.id : null,
      content: previous ? previous.content : customContent,
    });
    // Card ids are fixed up front, so posting a card again (a retry, another
    // server) finds the one already there instead of adding a second
    session.cardMessageId = uuidv4();
    session.resultMessageId = uuidv4();

    const saved = await this.store.create(session);
    await this.postCard(saved, 'invite');
    this.schedule(saved);
    // Never holds up the game: the invite card is already in the chat
    this.pushInvites(saved, chat, invitees.map(u => u.id), !!(previous || peerId))
      .catch(error => console.error('Game invite push failed:', error.message));
    return { session: engine.viewFor(saved, userId, this.now()) };
  }

  /** join | decline | leave | start | cancel | answer */
  async act(userId, sessionId, action) {
    const session = await this.loadAuthorized(userId, sessionId);
    let user = null;
    if (action.type === 'join' || action.type === 'decline') {
      const row = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });
      user = row ? userSummary(row) : { id: userId };
    }
    const result = await this.exclusive(session.id, () => this.store.update(session.id, (current) => {
      const now = this.now();
      return engine.applyAction(engine.advance(current, now), { ...action, userId, user }, now, this.rng);
    }));
    if (!result) throw new GameError('SESSION_NOT_FOUND');
    await this.afterChange(result.before, result.after);
    return { session: engine.viewFor(result.after, userId, this.now()) };
  }

  async get(userId, sessionId) {
    const session = await this.loadAuthorized(userId, sessionId);
    const current = (await this.tick(session.id)) || session;
    return { session: engine.viewFor(current, userId, this.now()) };
  }

  /** The chat's open game, if any (the banner over the conversation). */
  async openForChat(userId, chatId) {
    await this.authorize(userId, chatId);
    const open = await this.store.findOpen(chatId);
    if (!open) return { session: null };
    const current = await this.tick(open.id);
    if (!current || !engine.isOpen(current)) return { session: null };
    return { session: engine.viewFor(current, userId, this.now()) };
  }

  // ---------- saved custom games (private to their owner) ----------

  listCustomGames(userId) {
    return this.store.listCustomGames(userId).then(games => ({ games }));
  }

  async saveCustomGame(userId, input) {
    const { game } = validateGame(input);
    if ((await this.store.countCustomGames(userId)) >= LIMITS.maxSavedGames) throw new GameError('TOO_MANY_GAMES');
    return { game: await this.store.createCustomGame(userId, game) };
  }

  async updateCustomGame(userId, gameId, input) {
    if (!isUuid(gameId)) throw new GameError('INVALID_REQUEST');
    const { game } = validateGame(input);
    const updated = await this.store.updateCustomGame(gameId, userId, game);
    if (!updated) throw new GameError('GAME_NOT_FOUND');
    return { game: updated };
  }

  async deleteCustomGame(userId, gameId) {
    if (!isUuid(gameId)) throw new GameError('INVALID_REQUEST');
    if (!(await this.store.deleteCustomGame(gameId, userId))) throw new GameError('GAME_NOT_FOUND');
    return {};
  }

  // ---------- clock ----------

  /** Moves the session on if its deadline has passed. Resolves to the session. */
  async tick(sessionId) {
    const result = await this.exclusive(sessionId, () => this.store.update(sessionId, (current) => engine.advance(current, this.now())));
    if (!result) return null;
    await this.afterChange(result.before, result.after);
    return result.after;
  }

  schedule(session) {
    const existing = this.timers.get(session.id);
    if (existing) clearTimeout(existing);
    this.timers.delete(session.id);
    if (!engine.isOpen(session) || !session.deadline) return;
    const delay = Math.max(0, session.deadline - this.now()) + TIMER_SLACK_MS;
    const timer = setTimeout(() => {
      this.timers.delete(session.id);
      this.tick(session.id).catch(error => console.error('Game tick failed:', error.message));
    }, delay);
    timer.unref?.();
    this.timers.set(session.id, timer);
  }

  /**
   * Picks up sessions whose timer lived on a server that restarted or went
   * away. Every server runs it; the row lock makes the extra ticks harmless.
   */
  startSweeper(intervalMs = SWEEP_INTERVAL_MS) {
    if (this.sweeper) return;
    this.sweeper = setInterval(async () => {
      try {
        const due = await this.store.findDue(this.now() - 1000);
        for (const id of due) await this.tick(id);
      } catch (error) {
        console.error('Game sweep failed:', error.message);
      }
    }, intervalMs);
    this.sweeper.unref?.();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Runs `task` once any earlier task for the same session has finished. */
  exclusive(sessionId, task) {
    const previous = this.locks.get(sessionId) || Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => {});
    this.locks.set(sessionId, tail);
    tail.then(() => {
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    });
    return next;
  }

  // ---------- side effects ----------

  async afterChange(before, after) {
    if (!after || after === before) return;
    this.schedule(after);
    this.emitToChat(after.chatId, 'game_state', engine.viewFor(after, null, this.now()));

    const card = engine.cardFor(after, 'invite');
    if (JSON.stringify(card) !== JSON.stringify(engine.cardFor(before, 'invite'))) {
      await this.updateCard(after, card);
    }
    if (after.status === 'completed' && before.status !== 'completed') {
      await this.recordResults(after);
      await this.postCard(after, 'result');
    }
  }

  /** Creates the session's invite or result card in the chat (once). */
  async postCard(session, kind) {
    const id = kind === 'result' ? session.resultMessageId : session.cardMessageId;
    try {
      const card = engine.cardFor(session, kind);
      const [message, created] = await Message.findOrCreate({
        where: { id },
        defaults: {
          id,
          chatId: session.chatId,
          senderId: session.createdBy,
          content: cardText(card),
          messageType: 'game',
          isEncrypted: false,
          status: 'sent',
          encryptionMetadata: { game: card },
        },
      });
      if (!created) return;
      await Chat.update({ lastActivityAt: new Date() }, { where: { id: session.chatId } });
      const complete = await Message.findByPk(message.id, {
        include: [{ model: User, as: 'sender', attributes: ['id', 'username', 'avatar'] }],
      });
      this.emitToChat(session.chatId, 'new_message', complete ? complete.toJSON() : message.toJSON());
    } catch (error) {
      // A missing card must not fail the game itself
      console.error(`Failed to post game ${kind} card:`, error.message);
    }
  }

  async updateCard(session, card) {
    try {
      await Message.update(
        { content: cardText(card), encryptionMetadata: { game: card } },
        { where: { id: session.cardMessageId, chatId: session.chatId } },
      );
      this.emitToChat(session.chatId, 'game_card_updated', { chatId: session.chatId, messageId: session.cardMessageId, game: card });
    } catch (error) {
      console.error('Failed to update game card:', error.message);
    }
  }

  async recordResults(session) {
    const playing = session.players.filter(p => p.playing);
    const winners = new Set(engine.winnerIds(session));
    try {
      await this.store.saveResults(playing.map(p => ({
        sessionId: session.id,
        chatId: session.chatId,
        userId: p.userId,
        gameType: session.gameType,
        score: p.score,
        rank: p.rank,
        won: winners.has(p.userId),
        left: p.status === 'left',
        playerCount: playing.length,
        completedAt: session.endedAt,
      })));
    } catch (error) {
      console.error('Failed to record game results:', error.message);
    }
  }

  emitToChat(chatId, event, payload) {
    if (this.io) this.io.to(`chat_${chatId}`).emit(event, payload);
  }

  /**
   * Tells people who aren't in the app. A 1:1 peer or rematch players are asked
   * by name (`named`); a new group game reaches the whole group. Skips anyone who
   * muted the chat, is online (they see the card), or is blocked either way.
   * Each person's game-invite setting is checked when the push is sent.
   */
  async pushInvites(session, chat, inviteeIds, named) {
    const where = { chatId: session.chatId, isActive: true };
    if (named) where.userId = inviteeIds;
    const members = await ChatParticipant.findAll({ where, attributes: ['userId', 'isMuted', 'mutedUntil'] });
    const blocked = new Set(await blockedPeerIds(session.hostId));
    const host = session.players.find(p => p.userId === session.hostId);
    const { name: gameName } = engine.rulesOf(session);
    const now = new Date();

    for (const member of members) {
      const { userId } = member;
      if (userId === session.hostId || blocked.has(userId)) continue;
      if (member.isMuted && (!member.mutedUntil || new Date(member.mutedUntil) > now)) continue;
      if (await redisService.getUserOnlineStatus(userId)) continue;
      if (!(await redisService.claimOnce(`game_invite:${session.chatId}:${userId}`, INVITE_PUSH_WINDOW_SECONDS))) continue;
      await require('../notificationService').notifyGameInvite({
        userId,
        hostName: host?.username || 'Someone',
        gameName,
        chatId: session.chatId,
        chatName: chat.name,
        isGroup: !!chat.isGroup,
        sessionId: session.id,
      });
    }
  }

  /** Of `userIds`, the ones still active in the chat, with their names. */
  async activeUsers(chatId, userIds) {
    if (!userIds.length) return [];
    const rows = await ChatParticipant.findAll({
      where: { chatId, userId: userIds, isActive: true },
      include: [{ model: User, as: 'user', attributes: ['id', 'username', 'avatar'] }],
    });
    return rows.filter(r => r.user).map(r => userSummary(r.user));
  }
}

module.exports = new GameService();
module.exports.GameService = GameService;
module.exports.cardText = cardText;
