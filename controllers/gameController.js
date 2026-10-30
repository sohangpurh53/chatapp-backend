// REST side of in-chat games: the catalog, and reading a session back after the
// app was away (reconnect, reopened the conversation). Moves happen over the
// socket (socket/gameHandlers.js).
const games = require('../services/games');
const { GameError, statusFor } = require('../services/games/errors');

const handle = (run) => async (req, res) => {
  try {
    res.json({ success: true, ...(await run(req)) });
  } catch (error) {
    if (error instanceof GameError) {
      return res.status(statusFor(error)).json({ error: error.message, code: error.code });
    }
    console.error('Game request failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getCatalog = handle(async () => ({ games: games.catalog() }));

const getSession = handle((req) => games.get(req.user.id, req.params.sessionId));

const getOpenSession = handle((req) => games.openForChat(req.user.id, req.params.chatId));

const listCustomGames = handle((req) => games.listCustomGames(req.user.id));

const saveCustomGame = handle((req) => games.saveCustomGame(req.user.id, req.body));

const updateCustomGame = handle((req) => games.updateCustomGame(req.user.id, req.params.gameId, req.body));

const deleteCustomGame = handle((req) => games.deleteCustomGame(req.user.id, req.params.gameId));

module.exports = { getCatalog, getSession, getOpenSession, listCustomGames, saveCustomGame, updateCustomGame, deleteCustomGame };
