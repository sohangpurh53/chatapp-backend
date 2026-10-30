// The game session state machine. Pure: no database, sockets or clocks. Every
// function takes the session and the current time and returns a new session, so
// the rules can be tested on their own and the server stays the only authority
// on turns, timers and scores.
//
//   lobby ──start──▶ active ──last round──▶ completed
//     │                │
//     ├─ cancel/expire ├─ cancel ─────────▶ cancelled
//     ▼                └─ everyone left / nobody answering ─▶ abandoned
//   cancelled
//
// An active session moves through phases per round:
//   countdown (first round only) ▶ question ▶ reveal ▶ question ▶ … ▶ completed
const { getGame } = require('./catalog');
const { GameError } = require('./errors');

const TIMINGS = {
  countdownMs: 3000,
  revealMs: 4000,
  // A lobby nobody starts closes after this long
  lobbyTtlMs: 10 * 60 * 1000,
  // Rounds in a row with no answers before the session counts as abandoned
  maxIdleRounds: 2,
};

const OPEN = new Set(['lobby', 'active']);

const isOpen = (session) => OPEN.has(session.status);

const playerOf = (session, userId) => session.players.find(p => p.userId === userId) || null;

const joinedPlayers = (session) => session.players.filter(p => p.status === 'joined');

/**
 * The rules a session plays by: its catalog game, with the session's own content
 * (a saved custom game: its title, prompts, round count and round length) in
 * place of the built-in bank. Null for a game type the server doesn't know.
 */
const rulesOf = (session) => {
  const game = getGame(session.gameType);
  if (!game) return null;
  const content = session.content;
  if (!content) return game;
  return {
    ...game,
    name: content.title || game.name,
    bank: content.prompts,
    rounds: Math.min(content.rounds || content.prompts.length, content.prompts.length),
    roundMs: content.roundSeconds ? content.roundSeconds * 1000 : game.roundMs,
  };
};

const gameOf = (session) => {
  const game = rulesOf(session);
  if (!game) throw new GameError('UNKNOWN_GAME');
  return game;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Picks `count` prompts and shuffles each one's options (Fisher-Yates with `rng`). */
const pickPrompts = (bank, count, rng) => {
  const pool = bank.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length)).map(item => {
    const order = item.options.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return {
      id: item.id,
      text: item.question,
      options: order.map(i => item.options[i]),
      correctIndex: typeof item.answer === 'number' ? order.indexOf(item.answer) : null,
    };
  });
};

const newPlayer = (user, status, now) => ({
  userId: user.id,
  username: user.username || null,
  avatar: user.avatar || null,
  status,
  // Took part once the game started (stays true if they leave midway)
  playing: false,
  score: 0,
  rank: null,
  joinedAt: status === 'joined' ? now : null,
});

/**
 * A new lobby. The host has joined; `invitees` (the other member of a 1:1 chat,
 * or the members a group host picked) are listed as invited. Anyone else in the
 * conversation can still join while the lobby is open.
 */
const createSession = ({ id, chatId, gameType, host, invitees = [], direct = false, now, rematchOfId = null, content = null, challenge = null }) => {
  if (!getGame(gameType)) throw new GameError('UNKNOWN_GAME');
  const players = [newPlayer(host, 'joined', now)];
  for (const user of invitees) {
    if (user.id !== host.id && !players.some(p => p.userId === user.id)) {
      players.push(newPlayer(user, 'invited', now));
    }
  }
  return {
    id,
    chatId,
    gameType,
    direct,
    hostId: host.id,
    createdBy: host.id,
    status: 'lobby',
    endReason: null,
    players,
    state: null,
    version: 1,
    createdAt: now,
    startedAt: null,
    endedAt: null,
    deadline: now + TIMINGS.lobbyTtlMs,
    rematchOfId,
    // A custom game's own prompts (see rulesOf); null for catalog games
    content,
    // Set on a solo round answering a challenge: { id, targetScore, challengerName }
    challenge,
  };
};

// ---------- transitions (all mutate the clone they are given) ----------

const finish = (session, status, endReason, now) => {
  session.status = status;
  session.endReason = endReason;
  session.endedAt = now;
  session.deadline = null;
  if (session.state) {
    session.state.phase = 'ended';
    session.state.phaseEndsAt = null;
  }
  if (status === 'completed') rankPlayers(session);
};

/** Standard competition ranking (1, 1, 3) over everyone who played. */
const rankPlayers = (session) => {
  const playing = session.players.filter(p => p.playing);
  const sorted = playing.slice().sort((a, b) => b.score - a.score);
  sorted.forEach((player, i) => {
    player.rank = i > 0 && sorted[i - 1].score === player.score ? sorted[i - 1].rank : i + 1;
  });
};

const winnerIds = (session) => {
  if (session.status !== 'completed' || !rulesOf(session)?.scored) return [];
  // A solo round is won by beating the score it answers
  if (session.challenge) {
    return session.players.filter(p => p.playing && p.score > session.challenge.targetScore).map(p => p.userId);
  }
  return session.players
    .filter(p => p.playing && p.rank === 1 && p.score > 0)
    .map(p => p.userId);
};

/** Hands the session to the earliest player still in it; false if nobody is left. */
const transferHost = (session) => {
  const next = joinedPlayers(session)
    .slice()
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
  if (!next) return false;
  session.hostId = next.userId;
  return true;
};

const startQuestion = (session, game, now) => {
  const { state } = session;
  state.phase = 'question';
  state.phaseStartedAt = now;
  state.phaseEndsAt = now + game.roundMs;
  session.deadline = state.phaseEndsAt;
};

/** Scores the current round and shows the answer; may end an idle session. */
const closeRound = (session, game, now) => {
  const { state } = session;
  const answers = state.answers[state.round] || {};
  const prompt = state.prompts[state.round];
  const results = {};
  for (const [userId, answer] of Object.entries(answers)) {
    const points = game.score(prompt, answer.choice, answer.elapsedMs, game.roundMs);
    results[userId] = { choice: answer.choice, points, correct: prompt.correctIndex === answer.choice };
    const player = playerOf(session, userId);
    if (player) player.score += points;
  }
  state.results[state.round] = results;

  state.idleRounds = Object.keys(answers).length === 0 ? state.idleRounds + 1 : 0;
  if (state.idleRounds >= TIMINGS.maxIdleRounds) {
    finish(session, 'abandoned', 'inactive', now);
    return;
  }
  state.phase = 'reveal';
  state.phaseStartedAt = now;
  state.phaseEndsAt = now + TIMINGS.revealMs;
  session.deadline = state.phaseEndsAt;
};

/** True when every player still in the game has answered the current question. */
const everyoneAnswered = (session) => {
  const answers = session.state.answers[session.state.round] || {};
  const joined = joinedPlayers(session);
  return joined.length > 0 && joined.every(p => answers[p.userId]);
};

// ---------- public API ----------

/**
 * Moves the session along its clock: closes expired lobbies, opens and closes
 * rounds and finishes the game. Called on a timer, and lazily before every
 * action and read, so a session still moves on if a timer was lost.
 */
const advance = (session, now) => {
  if (!isOpen(session) || !session.deadline || now < session.deadline) return session;
  const next = clone(session);
  const game = gameOf(next);

  if (next.status === 'lobby') {
    finish(next, 'cancelled', 'expired', now);
  } else {
    const { state } = next;
    if (state.phase === 'countdown') {
      startQuestion(next, game, now);
    } else if (state.phase === 'question') {
      closeRound(next, game, now);
    } else if (state.phase === 'reveal') {
      if (state.round + 1 < state.prompts.length) {
        state.round += 1;
        startQuestion(next, game, now);
      } else {
        finish(next, 'completed', null, now);
      }
    }
  }
  next.version += 1;
  return next;
};

/**
 * Applies one player action. Returns the new session, or the same object when
 * the action changes nothing (joining twice). Throws GameError for anything the
 * rules don't allow.
 */
const applyAction = (session, action, now, rng = Math.random) => {
  const next = clone(session);
  const game = gameOf(next);
  const userId = action.userId;
  const player = playerOf(next, userId);

  if (!isOpen(next)) throw new GameError('SESSION_CLOSED');

  switch (action.type) {
    case 'join': {
      if (next.status !== 'lobby') throw new GameError('ALREADY_STARTED');
      if (player?.status === 'joined') return session;
      if (joinedPlayers(next).length >= game.maxPlayers) throw new GameError('GAME_FULL');
      if (player) {
        player.status = 'joined';
        player.joinedAt = now;
        if (action.user) Object.assign(player, { username: action.user.username || player.username, avatar: action.user.avatar || null });
      } else {
        next.players.push(newPlayer(action.user || { id: userId }, 'joined', now));
      }
      break;
    }

    case 'decline': {
      if (next.status !== 'lobby') throw new GameError('ALREADY_STARTED');
      if (userId === next.hostId) return applyAction(session, { ...action, type: 'leave' }, now, rng);
      if (player?.status === 'declined') return session;
      if (player) {
        player.status = 'declined';
        player.joinedAt = null;
      } else {
        next.players.push(newPlayer(action.user || { id: userId }, 'declined', now));
      }
      // In a 1:1 chat there is nobody else to wait for
      if (next.direct) finish(next, 'cancelled', 'declined', now);
      break;
    }

    case 'leave': {
      if (!player || player.status !== 'joined') return session;
      player.status = 'left';
      if (joinedPlayers(next).length === 0) {
        if (next.status === 'lobby') finish(next, 'cancelled', 'host_left', now);
        else finish(next, 'abandoned', 'everyone_left', now);
        break;
      }
      if (userId === next.hostId) transferHost(next);
      if (next.status === 'active' && next.state.phase === 'question' && everyoneAnswered(next)) {
        closeRound(next, game, now);
      }
      break;
    }

    case 'start': {
      if (userId !== next.hostId) throw new GameError('NOT_HOST');
      if (next.status !== 'lobby') throw new GameError('ALREADY_STARTED');
      const joined = joinedPlayers(next);
      if (joined.length < (next.challenge ? 1 : game.minPlayers)) throw new GameError('NOT_ENOUGH_PLAYERS');
      joined.forEach(p => { p.playing = true; });
      next.status = 'active';
      next.startedAt = now;
      next.state = {
        prompts: pickPrompts(game.bank, game.rounds, rng),
        round: 0,
        phase: 'countdown',
        phaseStartedAt: now,
        phaseEndsAt: now + TIMINGS.countdownMs,
        answers: [],
        results: [],
        idleRounds: 0,
      };
      next.deadline = next.state.phaseEndsAt;
      break;
    }

    case 'cancel': {
      if (userId !== next.hostId) throw new GameError('NOT_HOST');
      finish(next, 'cancelled', 'host_cancelled', now);
      break;
    }

    case 'answer': {
      if (!player || player.status !== 'joined' || !player.playing) throw new GameError('NOT_A_PLAYER');
      const { state } = next;
      if (next.status !== 'active' || state.phase !== 'question' || action.round !== state.round || now > state.phaseEndsAt) {
        throw new GameError('NOT_ACCEPTING_ANSWERS');
      }
      const prompt = state.prompts[state.round];
      if (!Number.isInteger(action.choice) || action.choice < 0 || action.choice >= prompt.options.length) {
        throw new GameError('INVALID_ANSWER');
      }
      state.answers[state.round] = state.answers[state.round] || {};
      if (state.answers[state.round][userId]) throw new GameError('ALREADY_ANSWERED');
      state.answers[state.round][userId] = { choice: action.choice, elapsedMs: now - state.phaseStartedAt };
      if (everyoneAnswered(next)) closeRound(next, game, now);
      break;
    }

    default:
      throw new GameError('INVALID_REQUEST');
  }

  next.version += 1;
  return next;
};

// ---------- what clients see ----------

const publicPlayer = (p) => ({
  userId: p.userId,
  username: p.username,
  avatar: p.avatar,
  status: p.status,
  playing: p.playing,
  score: p.score,
  rank: p.rank,
});

/**
 * The session as a conversation member sees it. Correct answers and other
 * players' choices stay hidden until the round is revealed.
 */
const viewFor = (session, viewerId, now) => {
  const game = rulesOf(session);
  const view = {
    id: session.id,
    chatId: session.chatId,
    gameType: session.gameType,
    gameName: game?.name || session.gameType,
    hostId: session.hostId,
    status: session.status,
    endReason: session.endReason,
    version: session.version,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    lobbyEndsAt: session.status === 'lobby' ? session.deadline : null,
    rematchOfId: session.rematchOfId || null,
    serverNow: now,
    minPlayers: game?.minPlayers,
    maxPlayers: game?.maxPlayers,
    totalRounds: session.state?.prompts.length || game?.rounds,
    roundSeconds: game ? Math.round(game.roundMs / 1000) : null,
    scored: !!game?.scored,
    // A made-up game: its rules, and a flag so apps can say the AI wrote it
    rules: session.content?.rules || null,
    aiGenerated: !!session.content?.aiGenerated,
    challenge: session.challenge || null,
    players: session.players.map(publicPlayer),
    winnerIds: winnerIds(session),
    round: null,
    review: null,
  };

  const { state } = session;
  if (session.status === 'active' && state) {
    const prompt = state.prompts[state.round];
    const answers = state.answers[state.round] || {};
    const revealed = state.phase === 'reveal';
    view.round = {
      index: state.round,
      phase: state.phase,
      phaseStartedAt: state.phaseStartedAt,
      phaseEndsAt: state.phaseEndsAt,
      prompt: state.phase === 'countdown' ? null : { text: prompt.text, options: prompt.options },
      answeredUserIds: Object.keys(answers),
      yourChoice: viewerId && answers[viewerId] ? answers[viewerId].choice : null,
      correctIndex: revealed ? prompt.correctIndex : null,
      results: revealed ? state.results[state.round] || {} : null,
    };
  }

  if (session.status === 'completed' && state) {
    view.review = state.prompts.map((prompt, i) => ({
      text: prompt.text,
      options: prompt.options,
      correctIndex: prompt.correctIndex,
      results: state.results[i] || {},
    }));
  }
  return view;
};

/** The compact summary stored on the chat message for this session. */
const cardFor = (session, kind) => {
  const game = rulesOf(session);
  return {
    kind,
    sessionId: session.id,
    gameType: session.gameType,
    gameName: game?.name || session.gameType,
    status: session.status,
    endReason: session.endReason,
    hostId: session.hostId,
    createdBy: session.createdBy,
    scored: !!game?.scored,
    totalRounds: session.state?.prompts.length || game?.rounds,
    players: session.players
      .filter(p => kind === 'invite' || p.playing)
      .map(({ userId, username, avatar, status, score, rank }) => ({ userId, username, avatar, status, score, rank })),
    winnerIds: winnerIds(session),
    rematchOfId: session.rematchOfId || null,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
  };
};

module.exports = {
  TIMINGS,
  createSession,
  advance,
  applyAction,
  viewFor,
  cardFor,
  isOpen,
  winnerIds,
  pickPrompts,
  rulesOf,
};
