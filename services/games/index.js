// In-chat games: who may do what, the session clock, and the cards each game
// leaves in the conversation. The rules themselves live in ./engine.
//
// Realtime: every change is broadcast as 'game_state' (a member's view, see
// engine.viewFor) to the chat_<id> room, and the invite card is kept current
// with 'game_card_updated'. Apps that were away fetch the session again
// (GET /api/games/sessions/:id), so nothing depends on a missed event.
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { Chat, User, Message, ChatParticipant } = require('../../models');
const redisService = require('../../config/redis');
const { isUuid } = require('../../utils/ids');
const { blockedPeerIds, blockState, directPeerId } = require('../../utils/blocks');
const engine = require('./engine');
const { getGame, isAvailable, publicCatalog } = require('./catalog');
const { FORMATS, LIMITS, toSessionContent, validateGame } = require('./customGames');
const { GameError } = require('./errors');
const stats = require('./stats');
const { dbStore } = require('./store');

const CREATE_COOLDOWN_MS = 5000;
const SWEEP_INTERVAL_MS = 15000;
// However often a chat starts games, one person gets one push about them per window
const INVITE_PUSH_WINDOW_SECONDS = 30 * 60;
const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;
// Longer than the longest possible solo round
const CHALLENGE_PLAY_MS = 30 * 60 * 1000;
// How long the server ending a game has to finish up before the sweeper steps in
const SETTLE_GRACE_MS = 30 * 1000;
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
  if (card.kind === 'challenge') {
    const target = card.targetScore.toLocaleString('en-US');
    if (card.status === 'completed') {
      return card.beat
        ? `🏆 ${card.takerName} beat ${card.challengerName}'s ${target} in ${card.gameName}`
        : `🎯 ${card.takerName} scored ${(card.score || 0).toLocaleString('en-US')}, short of ${card.challengerName}'s ${target}`;
    }
    if (card.status === 'pending' || card.status === 'accepted') return `🎯 ${card.challengerName}: can you beat my ${target} in ${card.gameName}?`;
    return `🎯 ${card.challengerName}'s ${card.gameName} challenge has closed`;
  }
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
      // The only way to get this code, unlike send_message, which pretends to work
      if (blockedByThem) throw new GameError('GAME_UNAVAILABLE');
    }
    return { chat, peerId, participant };
  }

  /**
   * Posting a game card follows the chat's rules for posting: announcement-only
   * groups and slow mode (admins are exempt), and a short cooldown for everyone.
   */
  claimPost(userId, chat, participant, now) {
    const settings = chat.settings || {};
    const isAdmin = participant.role === 'admin' || participant.role === 'moderator';
    if (chat.isGroup && !isAdmin && settings.onlyAdminsCanSend) throw new GameError('ADMINS_ONLY');
    const slowMs = chat.isGroup && !isAdmin ? (Number(settings.slowModeSeconds) || 0) * 1000 : 0;
    if (now - (this.lastCreateAt.get(userId) || 0) < Math.max(CREATE_COOLDOWN_MS, slowMs)) throw new GameError('RATE_LIMITED');
    this.lastCreateAt.set(userId, now);
  }

  async loadAuthorized(userId, sessionId) {
    if (!isUuid(sessionId)) throw new GameError('INVALID_REQUEST');
    const session = await this.store.get(sessionId);
    if (!session) throw new GameError('SESSION_NOT_FOUND');
    // A solo round in progress is only its player's business
    if (session.challenge && engine.isOpen(session) && !session.players.some(p => p.userId === userId)) {
      throw new GameError('SESSION_NOT_FOUND');
    }
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
      // It can hold names and text from the chat it was made from
      if (saved.sourceChatId && saved.sourceChatId !== chatId) throw new GameError('GAME_WRONG_CHAT');
      gameType = FORMATS[saved.format];
      customContent = toSessionContent(saved);
    } else if (getGame(gameType)?.custom && !rematchOf) {
      throw new GameError('UNKNOWN_GAME');
    }
    if (typeof gameType !== 'string' || !isAvailable(gameType)) throw new GameError('UNKNOWN_GAME');
    const { chat, peerId, participant } = await this.authorize(userId, chatId);

    const open = await this.store.findOpen(chatId);
    if (open) {
      const current = await this.tick(open.id);
      if (current && engine.isOpen(current)) {
        return { session: engine.viewFor(current, userId, this.now()), existing: true };
      }
    }

    const now = this.now();
    this.claimPost(userId, chat, participant, now);

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

    let saved;
    try {
      saved = await this.store.create(session);
    } catch (error) {
      // Someone else's game got in first (the database allows one per chat)
      if (error.name !== 'SequelizeUniqueConstraintError') throw error;
      const winner = await this.store.findOpen(chatId);
      if (!winner) throw error;
      return { session: engine.viewFor(winner, userId, this.now()), existing: true };
    }
    await this.postCard(saved, 'invite').catch(error => console.error('Failed to post game invite card:', error.message));
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

  // ---------- challenges ----------

  /** "Can you beat my score?" from a finished game, posted as a card in its chat. */
  async createChallenge(userId, { sessionId } = {}) {
    const session = await this.loadAuthorized(userId, sessionId);
    const rules = engine.rulesOf(session);
    const player = session.players.find(p => p.userId === userId);
    // Not custom games: their fixed rounds are visible to the chat after a game.
    // Not solo rounds: challenges would chain from one person's score.
    if (session.status !== 'completed' || !rules?.scored || session.content || session.challenge) throw new GameError('NOT_CHALLENGEABLE');
    if (!player?.playing || player.score <= 0) throw new GameError('NOT_CHALLENGEABLE');

    const waiting = await this.store.findPendingChallenge(session.chatId, userId);
    if (waiting) return { challenge: this.challengeCard(waiting), existing: true };
    // One challenge per game result, so one good score can't be replayed for stats
    if (await this.store.hasChallengeFrom(session.id, userId)) throw new GameError('ALREADY_CHALLENGED');

    const now = this.now();
    const { chat, peerId, participant } = await this.authorize(userId, session.chatId);
    this.claimPost(userId, chat, participant, now);
    const challenge = await this.store.createChallenge({
      id: uuidv4(),
      chatId: session.chatId,
      challengerId: userId,
      challengerName: player.username,
      sourceSessionId: session.id,
      gameType: session.gameType,
      gameName: rules.name,
      targetScore: player.score,
      targetUserId: peerId || null,
      status: 'pending',
      dismissedBy: [],
      cardMessageId: uuidv4(),
      expiresAt: new Date(now + CHALLENGE_TTL_MS),
    });
    await this.postChallengeCard(challenge);
    return { challenge: this.challengeCard(challenge) };
  }

  async acceptChallenge(userId, { challengeId } = {}) {
    const found = await this.loadChallenge(userId, challengeId);
    if (found.challengerId === userId || (found.targetUserId && found.targetUserId !== userId)) throw new GameError('NOT_YOUR_CHALLENGE');
    const host = await User.findByPk(userId, { attributes: ['id', 'username', 'avatar'] });
    if (!host) throw new GameError('ACCESS_DENIED');

    const sessionId = uuidv4();
    const challenge = await this.store.updateChallenge(found.id, (current) => {
      if (current.status !== 'pending' || new Date(current.expiresAt).getTime() <= this.now()) throw new GameError('CHALLENGE_CLOSED');
      // From here the clock is for playing: a round that never starts or ends lapses
      return { status: 'accepted', takerId: userId, takerName: host.username, sessionId, expiresAt: new Date(this.now() + CHALLENGE_PLAY_MS) };
    });

    const now = this.now();
    const created = engine.createSession({
      id: sessionId,
      chatId: found.chatId,
      gameType: found.gameType,
      host: userSummary(host),
      now,
      challenge: { id: found.id, targetScore: found.targetScore, challengerName: found.challengerName },
    });
    const session = await this.store.create(engine.applyAction(created, { type: 'start', userId }, now, this.rng));
    this.schedule(session);
    await this.updateChallengeCard(challenge);
    return { session: engine.viewFor(session, userId, this.now()) };
  }

  /** No thanks. In a 1:1 chat that closes it; in a group others can still take it. */
  async dismissChallenge(userId, { challengeId } = {}) {
    const found = await this.loadChallenge(userId, challengeId);
    if (found.challengerId === userId) throw new GameError('NOT_YOUR_CHALLENGE');
    const challenge = await this.store.updateChallenge(found.id, (current) => {
      if (current.status !== 'pending') return null;
      if (current.targetUserId === userId) return { status: 'dismissed' };
      if (current.targetUserId) throw new GameError('NOT_YOUR_CHALLENGE');
      return { dismissedBy: [...new Set([...(current.dismissedBy || []), userId])] };
    });
    await this.updateChallengeCard(challenge);
    return { challenge: this.challengeCard(challenge) };
  }

  async loadChallenge(userId, challengeId) {
    if (!isUuid(challengeId)) throw new GameError('INVALID_REQUEST');
    const challenge = await this.store.getChallenge(challengeId);
    if (!challenge) throw new GameError('CHALLENGE_CLOSED');
    try {
      await this.authorize(userId, challenge.chatId);
    } catch (error) {
      if (error.code === 'ACCESS_DENIED') throw new GameError('CHALLENGE_CLOSED');
      throw error;
    }
    return challenge;
  }

  /** The solo round ended. Not finishing counts as the challenge lapsing. */
  async finishChallenge(session) {
    const player = session.players[0];
    if (session.status === 'completed') await this.recordResults(session);
    const challenge = await this.store.updateChallenge(session.challenge.id, (current) => {
      if (current.status !== 'accepted') return null;
      return session.status === 'completed'
        ? { status: 'completed', score: player.score, beat: player.score > session.challenge.targetScore }
        : { status: 'expired' };
    });
    if (challenge) await this.updateChallengeCard(challenge);
  }

  async expireChallenge(id) {
    const challenge = await this.store.updateChallenge(id, (current) => (['pending', 'accepted'].includes(current.status) ? { status: 'expired' } : null));
    if (challenge?.status === 'expired') await this.updateChallengeCard(challenge);
  }

  challengeCard(c) {
    return {
      kind: 'challenge',
      challengeId: c.id,
      gameType: c.gameType,
      gameName: c.gameName,
      status: c.status,
      challengerId: c.challengerId,
      challengerName: c.challengerName,
      targetScore: c.targetScore,
      targetUserId: c.targetUserId || null,
      takerId: c.takerId || null,
      takerName: c.takerName || null,
      sessionId: c.sessionId || null,
      score: c.score ?? null,
      beat: c.beat ?? null,
      dismissedBy: c.dismissedBy || [],
      expiresAt: new Date(c.expiresAt).getTime(),
    };
  }

  async postChallengeCard(challenge) {
    const card = this.challengeCard(challenge);
    try {
      const message = await Message.create({
        id: challenge.cardMessageId,
        chatId: challenge.chatId,
        senderId: challenge.challengerId,
        content: cardText(card),
        messageType: 'game',
        isEncrypted: false,
        status: 'sent',
        encryptionMetadata: { game: card },
      });
      await Chat.update({ lastActivityAt: new Date() }, { where: { id: challenge.chatId } });
      const complete = await Message.findByPk(message.id, {
        include: [{ model: User, as: 'sender', attributes: ['id', 'username', 'avatar'] }],
      });
      this.emitToChat(challenge.chatId, 'new_message', complete ? complete.toJSON() : message.toJSON());
    } catch (error) {
      console.error('Failed to post challenge card:', error.message);
    }
  }

  async updateChallengeCard(challenge) {
    const card = this.challengeCard(challenge);
    try {
      await Message.update(
        { content: cardText(card), encryptionMetadata: { game: card } },
        { where: { id: challenge.cardMessageId, chatId: challenge.chatId } },
      );
      this.emitToChat(challenge.chatId, 'game_card_updated', { chatId: challenge.chatId, messageId: challenge.cardMessageId, game: card });
    } catch (error) {
      console.error('Failed to update challenge card:', error.message);
    }
  }

  // ---------- stats (a person's own, or one chat's) ----------

  async statsFor(userId) {
    const [results, counts] = await Promise.all([this.store.userResults(userId), this.store.challengeCounts(userId)]);
    const recentRows = results.slice(0, 20);
    const labels = await this.store.chatLabels(userId, [...new Set(recentRows.map(r => r.chatId))]);
    return {
      ...stats.summarize(results, counts),
      // Only chats the user is still in: a game there is theirs to reopen
      recent: recentRows.filter(r => labels[r.chatId]).map(r => ({
        sessionId: r.sessionId,
        chatId: r.chatId,
        chatName: labels[r.chatId],
        gameType: r.gameType,
        gameName: r.gameName || r.gameType,
        score: r.score,
        rank: r.rank,
        won: r.won,
        playerCount: r.playerCount,
        completedAt: new Date(r.completedAt).getTime(),
      })),
    };
  }

  async leaderboardFor(userId, chatId) {
    await this.authorize(userId, chatId);
    const [results, members] = await Promise.all([this.store.chatResults(chatId), this.store.leaderboardMembers(chatId)]);
    return { leaderboard: stats.leaderboard(results, members) };
  }

  // ---------- membership changes ----------

  /** Someone left or was removed: they stop counting in the chat's open game. */
  async memberLeft(chatId, userId) {
    const open = await this.store.findOpen(chatId);
    if (!open?.players.some(p => p.userId === userId && p.status === 'joined')) return;
    const result = await this.exclusive(open.id, () => this.store.update(open.id, (current) => {
      const now = this.now();
      return engine.applyAction(engine.advance(current, now), { type: 'leave', userId }, now, this.rng);
    }));
    if (result) await this.afterChange(result.before, result.after);
  }

  /** A block ends what the pair had going in their 1:1 chat. */
  async pairBlocked(userA, userB) {
    const chat = await Chat.findOne({
      where: {
        isGroup: false,
        [Op.or]: [
          { participant1Id: userA, participant2Id: userB },
          { participant1Id: userB, participant2Id: userA },
        ],
      },
      attributes: ['id'],
    });
    if (!chat) return;
    for (const id of [userA, userB]) {
      const waiting = await this.store.findPendingChallenge(chat.id, id);
      if (waiting) await this.expireChallenge(waiting.id);
    }
    const open = await this.store.findOpen(chat.id);
    if (!open) return;
    const result = await this.exclusive(open.id, () => this.store.update(open.id, (current) => (
      engine.isOpen(current)
        ? engine.applyAction(current, { type: 'cancel', userId: current.hostId, system: true }, this.now(), this.rng)
        : current
    )));
    if (result) await this.afterChange(result.before, result.after);
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
        const expired = await this.store.findExpiredChallengeIds(this.now());
        for (const id of expired) await this.expireChallenge(id);
        // Finished, but the server handling it never completed the follow-up
        const unsettled = await this.store.findUnsettled(this.now() - SETTLE_GRACE_MS);
        for (const session of unsettled) {
          if (!session.challenge) await this.updateCard(session, engine.cardFor(session, 'invite'));
          await this.settle(session);
        }
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
    // A solo round is private until it ends: only its player gets updates
    if (after.challenge) {
      const view = engine.viewFor(after, null, this.now());
      for (const player of after.players) this.emitToUser(player.userId, 'game_state', view);
      if (engine.isOpen(before) && !engine.isOpen(after)) await this.settle(after);
      return;
    }
    this.emitToChat(after.chatId, 'game_state', engine.viewFor(after, null, this.now()));

    const card = engine.cardFor(after, 'invite');
    if (JSON.stringify(card) !== JSON.stringify(engine.cardFor(before, 'invite'))) {
      await this.updateCard(after, card);
    }
    if (engine.isOpen(before) && !engine.isOpen(after)) await this.settle(after);
  }

  /**
   * What a finished session leaves behind. Safe to repeat: results and cards can't
   * be written twice. The sweeper retries any session not marked settled, so a
   * crash or a failed write right after a game ends loses nothing.
   */
  async settle(session) {
    try {
      if (session.challenge) {
        await this.finishChallenge(session);
      } else if (session.status === 'completed') {
        await this.recordResults(session);
        await this.postCard(session, 'result');
      }
      await this.store.markSettled(session.id);
    } catch (error) {
      console.error('Settling game failed, will retry:', error.message);
    }
  }

  /** Creates the session's invite or result card in the chat (once). */
  async postCard(session, kind) {
    const id = kind === 'result' ? session.resultMessageId : session.cardMessageId;
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
  }

  async updateCard(session, card) {
    try {
      await Message.update(
        { content: cardText(card), encryptionMetadata: { game: card } },
        { where: { id: session.cardMessageId, chatId: session.chatId } },
      );
      // Updates can arrive out of order: apps keep the highest version
      this.emitToChat(session.chatId, 'game_card_updated', {
        chatId: session.chatId, messageId: session.cardMessageId, game: { ...card, version: session.version },
      });
    } catch (error) {
      console.error('Failed to update game card:', error.message);
    }
  }

  async recordResults(session) {
    const playing = session.players.filter(p => p.playing);
    const winners = new Set(engine.winnerIds(session));
    await this.store.saveResults(playing.map(p => ({
        sessionId: session.id,
        chatId: session.chatId,
        userId: p.userId,
        gameType: session.gameType,
        gameName: engine.rulesOf(session)?.name || null,
        score: p.score,
        rank: p.rank,
        won: winners.has(p.userId),
        left: p.status === 'left',
        playerCount: playing.length,
        completedAt: session.endedAt,
    })));
  }

  emitToChat(chatId, event, payload) {
    if (this.io) this.io.to(`chat_${chatId}`).emit(event, payload);
  }

  emitToUser(userId, event, payload) {
    if (this.io) this.io.to(`user_${userId}`).emit(event, payload);
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
