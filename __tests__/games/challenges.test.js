const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

require.cache[require.resolve('../../services/notificationService')] = {
  id: 'notificationService', loaded: true, exports: { notifyGameInvite: async () => {} },
};
const redisService = require('../../config/redis');
const { GameService } = require('../../services/games');
const { summarize, leaderboard } = require('../../services/games/stats');
const engine = require('../../services/games/engine');
const { memoryStore, installChatWorld } = require('../helpers/gameHarness');

redisService.client.disconnect();
test.after(() => redisService.client.disconnect());

const GROUP = '11111111-1111-4111-8111-111111111111';
const DIRECT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const chats = [
  { id: GROUP, isGroup: true, members: ['alice', 'bob', 'cara'] },
  { id: DIRECT, isGroup: false, participant1Id: 'alice', participant2Id: 'bob', members: ['alice', 'bob'] },
  { id: OTHER, isGroup: true, members: ['dave'] },
];

let world;
let store;
let games;
let clock;
let emitted;

const advanceAll = async (id) => {
  const session = store.sessions.get(id);
  if (session?.deadline) clock = Math.max(clock, session.deadline);
  await games.tick(id);
};

/** Plays a finished game: `aliceRight` decides who scores. */
const finishedGame = async (chatId, players = ['alice', 'bob']) => {
  const { session } = await games.create('alice', { chatId, gameType: 'quick_trivia' });
  for (const p of players.slice(1)) await games.act(p, session.id, { type: 'join' });
  await games.act('alice', session.id, { type: 'start' });
  while (store.sessions.get(session.id).status === 'active') {
    const s = store.sessions.get(session.id);
    if (s.state.phase === 'question') {
      const round = s.state.round;
      const right = s.state.prompts[round].correctIndex;
      await games.act('alice', session.id, { type: 'answer', round, choice: right });
      for (const p of players.slice(1)) await games.act(p, session.id, { type: 'answer', round, choice: (right + 1) % 4 });
    }
    await advanceAll(session.id);
  }
  games.lastCreateAt.clear();
  return session.id;
};

const playSolo = async (user, sessionId, right) => {
  while (store.sessions.get(sessionId).status === 'active') {
    const s = store.sessions.get(sessionId);
    if (s.state.phase === 'question') {
      const round = s.state.round;
      const answer = s.state.prompts[round].correctIndex;
      await games.act(user, sessionId, { type: 'answer', round, choice: right ? answer : (answer + 1) % 4 });
    }
    await advanceAll(sessionId);
  }
};

beforeEach(() => {
  world = installChatWorld({ chats });
  store = memoryStore();
  clock = 1_000_000;
  emitted = [];
  games = new GameService({ store, now: () => clock });
  games.setIO({ to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
  // Clock is driven by hand here
  games.schedule = () => {};
});

afterEach(() => {
  games.stop();
  world.restore();
});

describe('challenges', () => {
  test('a player challenges with their score, and the card lands in the chat', async () => {
    const id = await finishedGame(DIRECT);
    const target = store.sessions.get(id).players[0].score;
    const { challenge } = await games.createChallenge('alice', { sessionId: id });
    assert.equal(challenge.targetScore, target);
    assert.equal(challenge.targetUserId, 'bob');
    assert.equal(challenge.status, 'pending');
    const card = emitted.find(e => e.event === 'new_message' && e.payload.encryptionMetadata?.game?.kind === 'challenge');
    assert.equal(card.room, `chat_${DIRECT}`);
    assert.match(card.payload.content, /can you beat my/);
  });

  test('only someone who scored in a finished scored game can challenge', async () => {
    const id = await finishedGame(GROUP);
    await assert.rejects(games.createChallenge('bob', { sessionId: id }), { code: 'NOT_CHALLENGEABLE' });
    await assert.rejects(games.createChallenge('cara', { sessionId: id }), { code: 'NOT_CHALLENGEABLE' });
    await assert.rejects(games.createChallenge('dave', { sessionId: id }), { code: 'SESSION_NOT_FOUND' });
  });

  test('one waiting challenge per person per chat', async () => {
    const id = await finishedGame(GROUP);
    const first = await games.createChallenge('alice', { sessionId: id });
    const again = await games.createChallenge('alice', { sessionId: id });
    assert.equal(again.existing, true);
    assert.equal(again.challenge.challengeId, first.challenge.challengeId);
    assert.equal(store.challenges.size, 1);
  });

  test('beating the score plays solo, stays private, then updates the one card', async () => {
    const id = await finishedGame(GROUP);
    const { challenge } = await games.createChallenge('alice', { sessionId: id });
    emitted.length = 0;

    const { session } = await games.acceptChallenge('cara', { challengeId: challenge.challengeId });
    assert.equal(session.status, 'active');
    assert.equal(session.challenge.targetScore, challenge.targetScore);
    // Taken: nobody else can
    await assert.rejects(games.acceptChallenge('bob', { challengeId: challenge.challengeId }), { code: 'CHALLENGE_CLOSED' });

    // It doesn't block the chat's own game
    assert.equal(await store.findOpen(GROUP), null);

    store.sessions.get(session.id).challenge.targetScore = 1;
    await playSolo('cara', session.id, true);

    const live = emitted.filter(e => e.event === 'game_state');
    assert.ok(live.length > 0 && live.every(e => e.room === 'user_cara'));
    assert.equal(emitted.some(e => e.event === 'new_message'), false);

    const done = store.challenges.get(challenge.challengeId);
    assert.equal(done.status, 'completed');
    assert.equal(done.score > 0, true);
    const update = emitted.filter(e => e.event === 'game_card_updated').pop();
    assert.equal(update.payload.game.status, 'completed');
    assert.equal(store.results.find(r => r.sessionId === session.id).userId, 'cara');
  });

  test('falling short is recorded without a win', async () => {
    const id = await finishedGame(GROUP);
    const { challenge } = await games.createChallenge('alice', { sessionId: id });
    const { session } = await games.acceptChallenge('cara', { challengeId: challenge.challengeId });
    const s = store.sessions.get(session.id);
    await playSolo('cara', s.id, false);
    const done = store.challenges.get(challenge.challengeId);
    assert.equal(done.status, 'completed');
    assert.equal(done.beat, false);
    assert.equal(store.results.find(r => r.sessionId === s.id).won, false);
  });

  test('walking away from the solo round closes the challenge', async () => {
    const id = await finishedGame(GROUP);
    const { challenge } = await games.createChallenge('alice', { sessionId: id });
    const { session } = await games.acceptChallenge('cara', { challengeId: challenge.challengeId });
    await games.act('cara', session.id, { type: 'leave' });
    assert.equal(store.challenges.get(challenge.challengeId).status, 'expired');
  });

  test('you cannot take your own challenge, or a 1:1 one aimed at someone else', async () => {
    const id = await finishedGame(DIRECT);
    const { challenge } = await games.createChallenge('alice', { sessionId: id });
    await assert.rejects(games.acceptChallenge('alice', { challengeId: challenge.challengeId }), { code: 'NOT_YOUR_CHALLENGE' });
    await assert.rejects(games.acceptChallenge('dave', { challengeId: challenge.challengeId }), { code: 'CHALLENGE_CLOSED' });
  });

  test('dismissing: closes a 1:1 challenge; in a group it only stops asking you', async () => {
    const direct = await games.createChallenge('alice', { sessionId: await finishedGame(DIRECT) });
    await games.dismissChallenge('bob', { challengeId: direct.challenge.challengeId });
    assert.equal(store.challenges.get(direct.challenge.challengeId).status, 'dismissed');

    games.lastCreateAt.clear();
    const group = await games.createChallenge('alice', { sessionId: await finishedGame(GROUP) });
    const { challenge } = await games.dismissChallenge('bob', { challengeId: group.challenge.challengeId });
    assert.deepEqual(challenge.dismissedBy, ['bob']);
    assert.equal(challenge.status, 'pending');
  });

  test('an unanswered challenge expires after a day', async () => {
    const id = await finishedGame(DIRECT);
    const { challenge } = await games.createChallenge('alice', { sessionId: id });
    clock += 24 * 60 * 60 * 1000 + 1;
    await assert.rejects(games.acceptChallenge('bob', { challengeId: challenge.challengeId }), { code: 'CHALLENGE_CLOSED' });
    await games.expireChallenge(challenge.challengeId);
    assert.equal(store.challenges.get(challenge.challengeId).status, 'expired');
  });

  test("a custom game's challenge can't be taken by someone who played it", async () => {
    const { game } = await games.saveCustomGame('alice', {
      title: 'Quiz', format: 'quiz', rounds: [1, 2, 3].map(i => ({ question: `Q${i}`, options: ['a', 'b'], answer: 0 })),
    });
    const { session } = await games.create('alice', { chatId: GROUP, customGameId: game.id });
    await games.act('bob', session.id, { type: 'join' });
    await games.act('alice', session.id, { type: 'start' });
    while (store.sessions.get(session.id).status === 'active') {
      const s = store.sessions.get(session.id);
      if (s.state.phase === 'question') {
        const round = s.state.round;
        await games.act('alice', session.id, { type: 'answer', round, choice: s.state.prompts[round].correctIndex });
      }
      await advanceAll(session.id);
    }
    games.lastCreateAt.clear();
    const { challenge } = await games.createChallenge('alice', { sessionId: session.id });
    await assert.rejects(games.acceptChallenge('bob', { challengeId: challenge.challengeId }), { code: 'ALREADY_PLAYED' });
    assert.equal((await games.acceptChallenge('cara', { challengeId: challenge.challengeId })).session.gameName, 'Quiz');
  });
});

describe('stats', () => {
  test('own numbers, bests and achievements from real results', async () => {
    await finishedGame(GROUP);
    const { totals, games: perGame, achievements, recent } = await games.statsFor('alice');
    assert.equal(totals.played, 1);
    assert.equal(totals.wins, 1);
    assert.equal(perGame[0].gameName, 'Quick Trivia');
    assert.ok(perGame[0].bestScore > 0);
    assert.equal(achievements.find(a => a.id === 'first_win').earned, true);
    assert.equal(achievements.find(a => a.id === 'regular').earned, false);
    assert.equal(recent.length, 1);
  });

  test('games from chats you left stay in totals but not in the recent list', async () => {
    await finishedGame(GROUP);
    store.leftChats.add(GROUP);
    const { totals, recent } = await games.statsFor('alice');
    assert.equal(totals.played, 1);
    assert.deepEqual(recent, []);
  });

  test('a leaderboard covers one chat, for its members, without opted-out people', async () => {
    await finishedGame(GROUP);
    store.boardMembers.push({ userId: 'alice', username: 'alice' });
    const { leaderboard: rows } = await games.leaderboardFor('cara', GROUP);
    assert.deepEqual(rows.map(r => r.userId), ['alice']);
    await assert.rejects(games.leaderboardFor('dave', GROUP), { code: 'ACCESS_DENIED' });
  });

  test('summarize and leaderboard order', () => {
    const results = [{ gameType: 'a', score: 5, won: true, userId: 'x' }, { gameType: 'a', score: 9, won: false, userId: 'y' }];
    assert.equal(summarize(results).games[0].bestScore, 9);
    const rows = leaderboard(results, [{ userId: 'y', username: 'y' }, { userId: 'x', username: 'x' }, { userId: 'z', username: 'z' }]);
    assert.deepEqual(rows.map(r => r.userId), ['x', 'y']);
  });
});

test('a solo round is won only by beating the target', () => {
  const session = {
    status: 'completed', gameType: 'quick_trivia', challenge: { targetScore: 100 },
    players: [{ userId: 'a', playing: true, score: 100 }],
  };
  assert.deepEqual(engine.winnerIds(session), []);
  session.players[0].score = 101;
  assert.deepEqual(engine.winnerIds(session), ['a']);
});
