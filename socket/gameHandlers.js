// Socket events for in-chat games. Every event answers through its
// acknowledgement: { ok: true, session } or { ok: false, error, code }.
// Updates for everyone in the chat arrive as 'game_state' / 'game_card_updated'
// (see services/games).
const games = require('../services/games');
const { GameError } = require('../services/games/errors');

const ACTIONS = {
  game_join: 'join',
  game_decline: 'decline',
  game_leave: 'leave',
  game_start: 'start',
  game_cancel: 'cancel',
};

function registerGameHandlers(socket) {
  const on = (event, run) => {
    socket.on(event, async (data, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      try {
        respond({ ok: true, ...(await run(data && typeof data === 'object' ? data : {})) });
      } catch (error) {
        if (!(error instanceof GameError)) console.error(`${event} failed:`, error);
        respond({
          ok: false,
          code: error instanceof GameError ? error.code : 'GAME_ERROR',
          error: error instanceof GameError ? error.message : 'Something went wrong with this game. Try again.',
        });
      }
    });
  };

  on('game_create', (data) => games.create(socket.userId, data));
  on('game_get', (data) => games.get(socket.userId, data.sessionId));
  for (const [event, type] of Object.entries(ACTIONS)) {
    on(event, (data) => games.act(socket.userId, data.sessionId, { type }));
  }
  on('game_challenge_create', (data) => games.createChallenge(socket.userId, data));
  on('game_challenge_accept', (data) => games.acceptChallenge(socket.userId, data));
  on('game_challenge_dismiss', (data) => games.dismissChallenge(socket.userId, data));
  on('game_answer', (data) => games.act(socket.userId, data.sessionId, {
    type: 'answer',
    round: data.round,
    choice: data.choice,
  }));
}

module.exports = { registerGameHandlers };
