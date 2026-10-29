// Errors raised by the games layer. Every message here is safe to show to the user.

const MESSAGES = {
  INVALID_REQUEST: 'That game request is not valid.',
  UNKNOWN_GAME: 'That game is not available.',
  GAME_UNAVAILABLE: 'Games are not available in this chat right now.',
  ACCESS_DENIED: 'You are not a member of this conversation.',
  USER_BLOCKED: 'You blocked this user. Unblock them to play together.',
  SESSION_NOT_FOUND: 'This game no longer exists.',
  SESSION_CLOSED: 'This game has already ended.',
  ALREADY_STARTED: 'This game has already started.',
  NOT_HOST: 'Only the person running this game can do that.',
  NOT_A_PLAYER: 'Join the game first.',
  GAME_FULL: 'This game is full.',
  NOT_ENOUGH_PLAYERS: 'Wait for at least one more player to join.',
  NOT_ACCEPTING_ANSWERS: 'This question is closed.',
  ALREADY_ANSWERED: 'You already answered this question.',
  INVALID_ANSWER: 'That answer is not one of the options.',
  RATE_LIMITED: 'Slow down a little and try again.',
};

class GameError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || 'Something went wrong with this game.');
    this.name = 'GameError';
    this.code = MESSAGES[code] ? code : 'GAME_ERROR';
  }
}

// HTTP status for REST callers
const STATUS = {
  INVALID_REQUEST: 400,
  INVALID_ANSWER: 400,
  UNKNOWN_GAME: 404,
  SESSION_NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  USER_BLOCKED: 403,
  GAME_UNAVAILABLE: 403,
  NOT_HOST: 403,
  RATE_LIMITED: 429,
};

const statusFor = (error) => STATUS[error?.code] || 409;

module.exports = { GameError, MESSAGES, statusFor };
