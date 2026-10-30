const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../../services/games/engine');
const { GAMES, speedScore, BASE_POINTS, SPEED_POINTS } = require('../../services/games/catalog');

const { TIMINGS } = engine;
const trivia = GAMES.quick_trivia;
const user = (id) => ({ id, username: id, avatar: null });
// Deterministic shuffles
const seeded = (seed = 1) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const lobby = (opts = {}) => engine.createSession({
  id: 's1', chatId: 'c1', gameType: 'quick_trivia', host: user('alice'), now: 0, ...opts,
});

const act = (session, type, userId, now, extra = {}) =>
  engine.applyAction(session, { type, userId, user: user(userId), ...extra }, now, seeded());

/** A started two-player game, past the countdown, on its first question. */
const started = () => {
  let s = act(lobby(), 'join', 'bob', 10);
  s = act(s, 'start', 'alice', 100);
  s = engine.advance(s, 100 + TIMINGS.countdownMs);
  return s;
};

const correct = (s) => s.state.prompts[s.state.round].correctIndex;
const wrong = (s) => (correct(s) + 1) % s.state.prompts[s.state.round].options.length;

describe('lobby', () => {
  test('the host has joined and the 1:1 peer is invited', () => {
    const s = lobby({ invitees: [user('bob')], direct: true });
    assert.deepEqual(s.players.map(p => [p.userId, p.status]), [['alice', 'joined'], ['bob', 'invited']]);
    assert.equal(s.status, 'lobby');
    assert.equal(s.deadline, TIMINGS.lobbyTtlMs);
  });

  test('joining twice changes nothing', () => {
    const once = act(lobby(), 'join', 'bob', 5);
    assert.equal(act(once, 'join', 'bob', 6), once);
  });

  test('declining in a 1:1 chat ends the invite; in a group it does not', () => {
    const direct = act(lobby({ invitees: [user('bob')], direct: true }), 'decline', 'bob', 5);
    assert.equal(direct.status, 'cancelled');
    assert.equal(direct.endReason, 'declined');

    const group = act(lobby(), 'decline', 'bob', 5);
    assert.equal(group.status, 'lobby');
    assert.equal(group.players.find(p => p.userId === 'bob').status, 'declined');
    // Changing your mind is fine while the lobby is open
    assert.equal(act(group, 'join', 'bob', 6).players.find(p => p.userId === 'bob').status, 'joined');
  });

  test('only the host can start, and not alone', () => {
    assert.throws(() => act(lobby(), 'start', 'alice', 5), { code: 'NOT_ENOUGH_PLAYERS' });
    const s = act(lobby(), 'join', 'bob', 5);
    assert.throws(() => act(s, 'start', 'bob', 6), { code: 'NOT_HOST' });
  });

  test('the game fills up at its player limit', () => {
    let s = lobby();
    for (let i = 1; i < trivia.maxPlayers; i++) s = act(s, 'join', `p${i}`, i);
    assert.throws(() => act(s, 'join', 'late', 99), { code: 'GAME_FULL' });
  });

  test('the host leaving hands the lobby on; the last player leaving cancels it', () => {
    let s = act(lobby(), 'join', 'bob', 5);
    s = act(s, 'leave', 'alice', 6);
    assert.equal(s.hostId, 'bob');
    assert.equal(s.status, 'lobby');
    s = act(s, 'leave', 'bob', 7);
    assert.equal(s.status, 'cancelled');
  });

  test('a player who is not the host leaving keeps the host', () => {
    let s = act(act(lobby(), 'join', 'bob', 5), 'join', 'cara', 6);
    s = act(s, 'leave', 'bob', 7);
    assert.equal(s.hostId, 'alice');
  });

  test('an unstarted lobby expires', () => {
    const s = engine.advance(lobby(), TIMINGS.lobbyTtlMs);
    assert.equal(s.status, 'cancelled');
    assert.equal(s.endReason, 'expired');
  });

  test('nobody can join once the game started', () => {
    let s = act(lobby(), 'join', 'bob', 5);
    s = act(s, 'start', 'alice', 6);
    assert.throws(() => act(s, 'join', 'cara', 7), { code: 'ALREADY_STARTED' });
  });
});

describe('rounds', () => {
  test('answers are refused during the countdown', () => {
    let s = act(lobby(), 'join', 'bob', 5);
    s = act(s, 'start', 'alice', 6);
    assert.equal(s.state.phase, 'countdown');
    assert.throws(() => act(s, 'answer', 'bob', 7, { round: 0, choice: 0 }), { code: 'NOT_ACCEPTING_ANSWERS' });
  });

  test('a second answer to the same question is refused', () => {
    const s = act(started(), 'answer', 'bob', 4000, { round: 0, choice: 0 });
    assert.throws(() => act(s, 'answer', 'bob', 4001, { round: 0, choice: 1 }), { code: 'ALREADY_ANSWERED' });
  });

  test('an answer for another round or an option that does not exist is refused', () => {
    const s = started();
    assert.throws(() => act(s, 'answer', 'bob', 4000, { round: 1, choice: 0 }), { code: 'NOT_ACCEPTING_ANSWERS' });
    assert.throws(() => act(s, 'answer', 'bob', 4000, { round: 0, choice: 9 }), { code: 'INVALID_ANSWER' });
    assert.throws(() => act(s, 'answer', 'bob', 4000, { round: 0, choice: '0' }), { code: 'INVALID_ANSWER' });
  });

  test('people who did not join cannot answer', () => {
    assert.throws(() => act(started(), 'answer', 'mallory', 4000, { round: 0, choice: 0 }), { code: 'NOT_A_PLAYER' });
  });

  test('an answer after the clock ran out is refused even if no tick ran yet', () => {
    const s = started();
    assert.throws(
      () => act(s, 'answer', 'bob', s.state.phaseEndsAt + 1, { round: 0, choice: 0 }),
      { code: 'NOT_ACCEPTING_ANSWERS' },
    );
  });

  test('the round closes as soon as everyone answered, scored on server time', () => {
    let s = started();
    const opened = s.state.phaseStartedAt;
    s = act(s, 'answer', 'alice', opened + 1500, { round: 0, choice: correct(s) });
    assert.equal(s.state.phase, 'question');
    s = act(s, 'answer', 'bob', opened + 3000, { round: 0, choice: wrong(s) });
    assert.equal(s.state.phase, 'reveal');
    const alice = s.players.find(p => p.userId === 'alice');
    assert.equal(alice.score, BASE_POINTS + Math.round(SPEED_POINTS * (1 - 1500 / trivia.roundMs)));
    assert.equal(s.players.find(p => p.userId === 'bob').score, 0);
  });

  test('the clock closes a round with missing answers and moves on', () => {
    let s = started();
    s = act(s, 'answer', 'alice', s.state.phaseStartedAt + 10, { round: 0, choice: correct(s) });
    s = engine.advance(s, s.state.phaseEndsAt);
    assert.equal(s.state.phase, 'reveal');
    s = engine.advance(s, s.state.phaseEndsAt);
    assert.equal(s.state.phase, 'question');
    assert.equal(s.state.round, 1);
  });

  test('advance before the deadline changes nothing', () => {
    const s = started();
    assert.equal(engine.advance(s, s.state.phaseEndsAt - 1), s);
  });

  test('a player leaving mid-question no longer holds the round open', () => {
    let s = started();
    s = act(s, 'answer', 'alice', s.state.phaseStartedAt + 10, { round: 0, choice: 0 });
    s = act(s, 'leave', 'bob', s.state.phaseStartedAt + 20);
    assert.equal(s.state.phase, 'reveal');
  });

  test('nobody answering for two rounds abandons the game', () => {
    let s = started();
    for (let i = 0; i < 3 && s.status === 'active'; i++) s = engine.advance(s, s.deadline);
    assert.equal(s.status, 'abandoned');
    assert.equal(s.endReason, 'inactive');
  });

  test('everyone leaving abandons the game', () => {
    let s = act(started(), 'leave', 'alice', 4000);
    s = act(s, 'leave', 'bob', 4001);
    assert.equal(s.status, 'abandoned');
    assert.equal(s.endReason, 'everyone_left');
  });

  test('the host can cancel a running game, nobody else can', () => {
    assert.throws(() => act(started(), 'cancel', 'bob', 4000), { code: 'NOT_HOST' });
    const s = act(started(), 'cancel', 'alice', 4000);
    assert.equal(s.status, 'cancelled');
    assert.throws(() => act(s, 'answer', 'bob', 4001, { round: 0, choice: 0 }), { code: 'SESSION_CLOSED' });
  });
});

describe('completion', () => {
  const playThrough = (aliceRight, bobRight) => {
    let s = started();
    while (s.status === 'active') {
      const t = s.state.phaseStartedAt + 1000;
      s = act(s, 'answer', 'alice', t, { round: s.state.round, choice: aliceRight ? correct(s) : wrong(s) });
      s = act(s, 'answer', 'bob', t, { round: s.state.round, choice: bobRight ? correct(s) : wrong(s) });
      s = engine.advance(s, s.deadline);
    }
    return s;
  };

  test('the highest score wins and is ranked first', () => {
    const s = playThrough(true, false);
    assert.equal(s.status, 'completed');
    assert.deepEqual(engine.winnerIds(s), ['alice']);
    assert.equal(s.players.find(p => p.userId === 'alice').rank, 1);
    assert.equal(s.players.find(p => p.userId === 'bob').rank, 2);
    assert.equal(s.state.prompts.length, trivia.rounds);
  });

  test('equal scores share the rank and the win', () => {
    const s = playThrough(true, true);
    assert.deepEqual(engine.winnerIds(s).sort(), ['alice', 'bob']);
    assert.deepEqual(s.players.map(p => p.rank), [1, 1]);
  });

  test('nobody wins with zero points', () => {
    assert.deepEqual(engine.winnerIds(playThrough(false, false)), []);
  });

  test('the review shows every question with its answer once completed', () => {
    const view = engine.viewFor(playThrough(true, false), 'bob', 0);
    assert.equal(view.review.length, trivia.rounds);
    assert.equal(typeof view.review[0].correctIndex, 'number');
  });
});

describe('what members see', () => {
  test('the correct answer and other choices stay hidden until the reveal', () => {
    let s = started();
    s = act(s, 'answer', 'alice', s.state.phaseStartedAt + 10, { round: 0, choice: 2 });
    const bobView = engine.viewFor(s, 'bob', 0);
    assert.equal(bobView.round.correctIndex, null);
    assert.equal(bobView.round.results, null);
    assert.equal(bobView.round.yourChoice, null);
    assert.deepEqual(bobView.round.answeredUserIds, ['alice']);
    assert.equal(engine.viewFor(s, 'alice', 0).round.yourChoice, 2);
    assert.equal(JSON.stringify(bobView).includes('"answers"'), false);
    assert.equal(JSON.stringify(bobView).includes('elapsedMs'), false);

    s = act(s, 'answer', 'bob', s.state.phaseStartedAt + 20, { round: 0, choice: 1 });
    const revealed = engine.viewFor(s, 'bob', 0).round;
    assert.equal(revealed.correctIndex, correct(s));
    assert.equal(revealed.results.alice.choice, 2);
  });

  test('the countdown shows no question yet', () => {
    let s = act(lobby(), 'join', 'bob', 5);
    s = act(s, 'start', 'alice', 6);
    assert.equal(engine.viewFor(s, 'bob', 0).round.prompt, null);
  });

  test('the result card lists only people who played', () => {
    let s = act(act(lobby(), 'join', 'bob', 5), 'decline', 'cara', 6);
    s = act(s, 'start', 'alice', 7);
    const card = engine.cardFor(s, 'result');
    assert.deepEqual(card.players.map(p => p.userId), ['alice', 'bob']);
    assert.deepEqual(engine.cardFor(s, 'invite').players.map(p => p.userId), ['alice', 'bob', 'cara']);
  });
});

describe('custom content', () => {
  const content = {
    title: 'Our cricket quiz',
    roundSeconds: 20,
    rounds: 2,
    prompts: [
      { id: 'a', question: 'Q1?', options: ['x', 'y'], answer: 1 },
      { id: 'b', question: 'Q2?', options: ['x', 'y', 'z'], answer: 2 },
      { id: 'c', question: 'Q3?', options: ['x', 'y'], answer: 0 },
    ],
  };

  test('a session plays its own prompts, round count and clock', () => {
    let s = act(lobby({ content }), 'join', 'bob', 5);
    s = act(s, 'start', 'alice', 6);
    s = engine.advance(s, s.deadline);
    assert.equal(s.state.prompts.length, 2);
    assert.ok(s.state.prompts.every(p => ['a', 'b', 'c'].includes(p.id)));
    assert.equal(s.state.phaseEndsAt - s.state.phaseStartedAt, 20000);
    assert.equal(engine.viewFor(s, 'bob', 0).gameName, 'Our cricket quiz');
  });
});

test('speed score: wrong answers score nothing; late right answers keep the base', () => {
  const prompt = { correctIndex: 1 };
  assert.equal(speedScore(prompt, 0, 0, 1000), 0);
  assert.equal(speedScore(prompt, 1, 0, 1000), BASE_POINTS + SPEED_POINTS);
  assert.equal(speedScore(prompt, 1, 5000, 1000), BASE_POINTS);
});

test('prompts are drawn without repeats and keep their correct answer', () => {
  const prompts = engine.pickPrompts(trivia.bank, 5, seeded(7));
  assert.equal(new Set(prompts.map(p => p.id)).size, 5);
  for (const p of prompts) {
    const source = trivia.bank.find(q => q.id === p.id);
    assert.equal(p.options[p.correctIndex], source.options[source.answer]);
  }
});

describe('built-in content', () => {
  for (const id of ['quick_trivia', 'emoji_puzzle', 'would_you_rather']) {
    test(`${id}: every prompt is playable, with no repeats`, () => {
      const game = GAMES[id];
      assert.ok(game.bank.length >= game.rounds * 4);
      assert.equal(new Set(game.bank.map(p => p.id)).size, game.bank.length);
      for (const prompt of game.bank) {
        assert.ok(prompt.options.length >= 2 && prompt.options.length <= 4);
        assert.equal(new Set(prompt.options).size, prompt.options.length);
        if (game.scored) assert.ok(prompt.options[prompt.answer]);
        else assert.equal(prompt.answer, undefined);
      }
    });
  }

  test('Would You Rather has no right answers, scores or winners', () => {
    let s = engine.createSession({ id: 's', chatId: 'c', gameType: 'would_you_rather', host: user('alice'), now: 0 });
    s = act(s, 'join', 'bob', 1);
    s = act(s, 'start', 'alice', 2);
    while (s.status === 'active') {
      if (s.state.phase === 'question') {
        const round = s.state.round;
        const t = s.state.phaseStartedAt + 10;
        s = act(s, 'answer', 'alice', t, { round, choice: 0 });
        s = act(s, 'answer', 'bob', t, { round, choice: 1 });
        const revealed = engine.viewFor(s, 'bob', 0).round;
        assert.equal(revealed.correctIndex, null);
        assert.equal(revealed.results.alice.points, 0);
      }
      s = engine.advance(s, s.deadline);
    }
    assert.equal(s.status, 'completed');
    assert.deepEqual(engine.winnerIds(s), []);
    assert.ok(s.players.every(p => p.score === 0));
  });

  test('custom rule sets never reach the picker', () => {
    const { publicCatalog } = require('../../services/games/catalog');
    assert.deepEqual(publicCatalog().map(g => g.id), ['quick_trivia', 'emoji_puzzle', 'would_you_rather']);
  });
});
