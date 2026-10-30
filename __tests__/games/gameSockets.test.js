// Whole games over real sockets: phones in a group and a 1:1 chat create, join,
// play, drop out and come back, against the real SocketHandlers and game service.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { gameInvites, installCallStore, startServer, until, redisService } = require('../helpers/callHarness');
const { memoryStore, installChatWorld } = require('../helpers/gameHarness');
const games = require('../../services/games');
const engine = require('../../services/games/engine');
const { GAMES } = require('../../services/games/catalog');

const GROUP = '11111111-1111-4111-8111-111111111111';
const DIRECT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const chats = [
  { id: GROUP, isGroup: true, members: ['alice', 'bob', 'cara'] },
  { id: DIRECT, isGroup: false, participant1Id: 'alice', participant2Id: 'erin', members: ['alice', 'erin'] },
  { id: OTHER, isGroup: true, members: ['dave'] },
];

// Fast clock for the real timers
const fast = { roundMs: 400, countdownMs: 60, revealMs: 60 };
const saved = {};

let callStore;
let world;
let server;
let store;

const call = (phone, event, data) => phone.socket.timeout(2000).emitWithAck(event, data);

/** Waits until this phone's latest game_state for the session matches. */
const stateOn = (phone, sessionId, predicate) => until(() => {
  const states = phone.all('game_state').filter(s => s.id === sessionId);
  const latest = states[states.length - 1];
  return latest && predicate(latest) ? latest : null;
}, { label: `game_state on ${phone.userId}` });

const correctChoice = (sessionId) => {
  const s = store.sessions.get(sessionId);
  return s.state.prompts[s.state.round].correctIndex;
};

beforeEach(async () => {
  saved.roundMs = GAMES.quick_trivia.roundMs;
  saved.countdownMs = engine.TIMINGS.countdownMs;
  saved.revealMs = engine.TIMINGS.revealMs;
  GAMES.quick_trivia.roundMs = fast.roundMs;
  engine.TIMINGS.countdownMs = fast.countdownMs;
  engine.TIMINGS.revealMs = fast.revealMs;

  callStore = installCallStore();
  world = installChatWorld({ chats, blocks: [['erin', 'alice']] });
  store = memoryStore();
  games.store = store;
  games.lastCreateAt.clear();
  gameInvites.length = 0;
  server = await startServer();
  games.setIO(server.io);
});

afterEach(async () => {
  games.stop();
  await server.close();
  world.restore();
  callStore.restore();
  GAMES.quick_trivia.roundMs = saved.roundMs;
  engine.TIMINGS.countdownMs = saved.countdownMs;
  engine.TIMINGS.revealMs = saved.revealMs;
});

describe('a group game', () => {
  test('invite, join, play every round, and a result card everyone in the chat sees', async () => {
    const alice = await server.phone('alice');
    const bob = await server.phone('bob');
    const cara = await server.phone('cara');
    const dave = await server.phone('dave');

    const created = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    assert.equal(created.ok, true);
    const id = created.session.id;
    assert.equal(created.session.status, 'lobby');

    // The invite card reaches the conversation, and only the conversation
    const invite = await bob.waitFor('new_message', m => m.messageType === 'game');
    assert.equal(invite.isEncrypted, false);
    assert.equal(invite.encryptionMetadata.game.kind, 'invite');
    assert.equal(invite.encryptionMetadata.game.sessionId, id);
    await cara.waitFor('new_message', m => m.messageType === 'game');

    assert.equal((await call(bob, 'game_join', { sessionId: id })).ok, true);
    assert.equal((await call(cara, 'game_decline', { sessionId: id })).ok, true);
    const card = await alice.waitFor('game_card_updated', u => u.game.players.some(p => p.userId === 'cara' && p.status === 'declined'));
    assert.equal(card.messageId, invite.id);

    // Only the host starts
    assert.equal((await call(bob, 'game_start', { sessionId: id })).code, 'NOT_HOST');
    assert.equal((await call(alice, 'game_start', { sessionId: id })).ok, true);

    for (let round = 0; round < GAMES.quick_trivia.rounds; round++) {
      await stateOn(bob, id, s => s.round?.index === round && s.round.phase === 'question');
      const right = correctChoice(id);
      const answer = await call(alice, 'game_answer', { sessionId: id, round, choice: right });
      assert.equal(answer.ok, true);
      assert.equal(answer.session.round.yourChoice, right);
      // Tapping again (a double tap, a retry) does not count twice
      assert.equal((await call(alice, 'game_answer', { sessionId: id, round, choice: right })).code, 'ALREADY_ANSWERED');
      // Bob answers wrong; the round then closes without waiting for the clock
      assert.equal((await call(bob, 'game_answer', { sessionId: id, round, choice: (right + 1) % 4 })).ok, true);
    }

    const final = await stateOn(cara, id, s => s.status === 'completed');
    assert.deepEqual(final.winnerIds, ['alice']);
    // Answers are only revealed once the game is over
    assert.equal(final.review.length, GAMES.quick_trivia.rounds);

    const result = await cara.waitFor('new_message', m => m.encryptionMetadata?.game?.kind === 'result');
    assert.match(result.content, /alice won Quick Trivia/);
    assert.deepEqual(result.encryptionMetadata.game.players.map(p => p.userId), ['alice', 'bob']);
    assert.deepEqual(store.results.map(r => [r.userId, r.won]).sort(), [['alice', true], ['bob', false]]);

    // The finished game is still there to review, for members only
    const review = await call(bob, 'game_get', { sessionId: id });
    assert.equal(review.session.review.length, GAMES.quick_trivia.rounds);
    assert.equal((await call(dave, 'game_get', { sessionId: id })).code, 'SESSION_NOT_FOUND');
    assert.equal((await call(alice, 'game_answer', { sessionId: id, round: 0, choice: 0 })).code, 'SESSION_CLOSED');

    // Nothing about the game reached someone outside the chat
    assert.equal(dave.names().some(n => n.startsWith('game_') || n === 'new_message'), false);
  });

  test('the clock runs the game when someone stops answering', async () => {
    const alice = await server.phone('alice');
    const bob = await server.phone('bob');
    const { session } = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await call(bob, 'game_join', { sessionId: session.id });
    await call(alice, 'game_start', { sessionId: session.id });

    await stateOn(alice, session.id, s => s.round?.phase === 'question');
    await call(alice, 'game_answer', { sessionId: session.id, round: 0, choice: correctChoice(session.id) });
    // Bob never answers: the server closes the round on its own clock
    const revealed = await stateOn(alice, session.id, s => s.round?.phase === 'reveal');
    assert.equal(revealed.round.results.bob, undefined);
    await stateOn(alice, session.id, s => s.round?.index === 1);
  });

  test('a phone that drops mid-game gets the current state back on its return', async () => {
    const alice = await server.phone('alice');
    const bob = await server.phone('bob');
    const { session } = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await call(bob, 'game_join', { sessionId: session.id });
    await call(alice, 'game_start', { sessionId: session.id });
    await stateOn(bob, session.id, s => s.round?.phase === 'question');
    await call(bob, 'game_answer', { sessionId: session.id, round: 0, choice: 1 });

    bob.drop();
    const back = await server.phone('bob');
    const { session: current } = await call(back, 'game_get', { sessionId: session.id });
    assert.equal(current.status, 'active');
    if (current.round.index === 0 && current.round.phase === 'question') {
      assert.equal(current.round.yourChoice, 1);
    }
    // Dropping is not leaving
    assert.equal(current.players.find(p => p.userId === 'bob').status, 'joined');
  });

  test('one game at a time per chat: starting another returns the open one', async () => {
    const alice = await server.phone('alice');
    const bob = await server.phone('bob');
    const first = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    const second = await call(bob, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    assert.equal(second.ok, true);
    assert.equal(second.existing, true);
    assert.equal(second.session.id, first.session.id);
    assert.equal([...world.messages.values()].filter(m => m.messageType === 'game').length, 1);
  });

  test('the host cancelling closes the invite card', async () => {
    const alice = await server.phone('alice');
    const bob = await server.phone('bob');
    const { session } = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    assert.equal((await call(alice, 'game_cancel', { sessionId: session.id })).ok, true);
    const update = await bob.waitFor('game_card_updated', u => u.game.status === 'cancelled');
    assert.equal(update.game.endReason, 'host_cancelled');
    assert.match(world.messages.get(update.messageId).content, /cancelled/);
  });

  test('a rematch re-invites the same players', async () => {
    const alice = await server.phone('alice');
    const bob = await server.phone('bob');
    const { session } = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await call(bob, 'game_join', { sessionId: session.id });
    await call(alice, 'game_start', { sessionId: session.id });
    await games.act('alice', session.id, { type: 'cancel', system: true });

    games.lastCreateAt.clear();
    const rematch = await call(bob, 'game_create', { chatId: GROUP, gameType: 'quick_trivia', rematchOf: session.id });
    assert.equal(rematch.ok, true);
    assert.equal(rematch.session.hostId, 'bob');
    assert.equal(rematch.session.rematchOfId, session.id);
    assert.deepEqual(rematch.session.players.map(p => [p.userId, p.status]), [['bob', 'joined'], ['alice', 'invited']]);
  });
});

describe('access', () => {
  test('outsiders, unknown games and bad ids are refused', async () => {
    const dave = await server.phone('dave');
    const alice = await server.phone('alice');
    assert.equal((await call(dave, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' })).code, 'ACCESS_DENIED');
    assert.equal((await call(alice, 'game_create', { chatId: GROUP, gameType: 'chess' })).code, 'UNKNOWN_GAME');
    assert.equal((await call(alice, 'game_create', { chatId: 'not-a-uuid', gameType: 'quick_trivia' })).code, 'INVALID_REQUEST');
    assert.equal((await call(alice, 'game_join', { sessionId: 'nope' })).code, 'INVALID_REQUEST');
  });

  test('a blocked 1:1 pair cannot start games, in either direction', async () => {
    const alice = await server.phone('alice');
    const erin = await server.phone('erin');
    // erin blocked alice: alice is not told why
    assert.equal((await call(alice, 'game_create', { chatId: DIRECT, gameType: 'quick_trivia' })).code, 'GAME_UNAVAILABLE');
    assert.equal((await call(erin, 'game_create', { chatId: DIRECT, gameType: 'quick_trivia' })).code, 'USER_BLOCKED');
  });

  test('creating games back to back is rate limited', async () => {
    const alice = await server.phone('alice');
    const { session } = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await call(alice, 'game_cancel', { sessionId: session.id });
    assert.equal((await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' })).code, 'RATE_LIMITED');
  });
});

describe('a 1:1 game', () => {
  test('the other person is invited by name, and declining closes the invite', async () => {
    world.restore();
    world = installChatWorld({ chats });
    const alice = await server.phone('alice');
    const erin = await server.phone('erin');
    const { session } = await call(alice, 'game_create', { chatId: DIRECT, gameType: 'quick_trivia' });
    assert.deepEqual(session.players.map(p => [p.userId, p.status]), [['alice', 'joined'], ['erin', 'invited']]);
    await call(erin, 'game_decline', { sessionId: session.id });
    const update = await alice.waitFor('game_card_updated', u => u.game.status === 'cancelled');
    assert.equal(update.game.endReason, 'declined');
  });
});

describe('invite pushes', () => {
  const pushedTo = () => gameInvites.map(p => p.userId).sort();

  test('a new group game reaches offline members, not the host or people in the app', async () => {
    const alice = await server.phone('alice');
    await server.phone('bob');
    world.online.add('bob');
    await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await until(() => gameInvites.length === 1, { label: 'push' });
    assert.deepEqual(pushedTo(), ['cara']);
    assert.equal(gameInvites[0].gameName, 'Quick Trivia');
    assert.equal(gameInvites[0].isGroup, true);
  });

  test('muting the chat or a block means no push', async () => {
    world.restore();
    world = installChatWorld({
      chats: [{ id: GROUP, isGroup: true, members: ['alice', 'bob', 'cara'], muted: ['bob'] }],
      blocks: [['cara', 'alice']],
    });
    const { UserBlock } = require('../../models');
    const findAll = UserBlock.findAll;
    UserBlock.findAll = async () => [{ blockerId: 'cara', blockedId: 'alice' }];
    const alice = await server.phone('alice');
    await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await new Promise(resolve => setTimeout(resolve, 50));
    UserBlock.findAll = findAll;
    assert.deepEqual(pushedTo(), []);
  });

  test('starting game after game pushes once per person', async () => {
    const alice = await server.phone('alice');
    const first = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await until(() => gameInvites.length === 2, { label: 'first pushes' });
    await call(alice, 'game_cancel', { sessionId: first.session.id });
    games.lastCreateAt.clear();
    await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(pushedTo(), ['bob', 'cara']);
  });

  test('a rematch only asks the people who played', async () => {
    const alice = await server.phone('alice');
    const bob = await server.phone('bob');
    world.online.add('bob');
    const { session } = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await call(bob, 'game_join', { sessionId: session.id });
    await call(alice, 'game_start', { sessionId: session.id });
    await games.act('alice', session.id, { type: 'cancel', system: true });
    world.claims.clear();
    gameInvites.length = 0;
    world.online.clear();
    world.online.add('alice');
    games.lastCreateAt.clear();
    await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia', rematchOf: session.id });
    await until(() => gameInvites.length > 0, { label: 'rematch push' });
    assert.deepEqual(pushedTo(), ['bob']);
  });
});

describe('rooms and forged cards', () => {
  test('join_chat only lets members into a chat room', async () => {
    const dave = await server.phone('dave');
    const alice = await server.phone('alice');
    dave.emit('join_chat', { chatId: GROUP });
    await new Promise(resolve => setTimeout(resolve, 50));
    dave.clear();
    await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(dave.names(), []);
  });

  test('apps cannot send game cards', async () => {
    const alice = await server.phone('alice');
    const ack = await call(alice, 'send_message', {
      chatId: GROUP, messageType: 'game', content: 'x', encryptionMetadata: { game: { sessionId: 'x' } },
    });
    assert.equal(ack.code, 'INVALID_MESSAGE_TYPE');
    assert.equal(world.messages.size, 0);
  });
});

test('sweeper finishes sessions whose timer was lost', async () => {
  const alice = await server.phone('alice');
  const { session } = await call(alice, 'game_create', { chatId: GROUP, gameType: 'quick_trivia' });
  // As if the server that held the timer went away
  games.stop();
  store.sessions.get(session.id).deadline = Date.now() - 5000;
  games.startSweeper(20);
  await until(() => store.sessions.get(session.id).status === 'cancelled', { label: 'expired lobby' });
});

// Shared harness opens a Redis client against the closed test port
test.after(() => redisService.client?.disconnect?.());
