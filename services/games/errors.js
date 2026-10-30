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
  INVALID_GAME: 'This game needs a title and at least 3 complete rounds.',
  GAME_NOT_FOUND: 'That saved game no longer exists.',
  NOT_CHALLENGEABLE: 'Only a scored game you played can be turned into a challenge.',
  CHALLENGE_CLOSED: 'This challenge is no longer open.',
  NOT_YOUR_CHALLENGE: 'This challenge is for someone else.',
  ALREADY_CHALLENGED: 'You already challenged friends with this score.',
  ADMINS_ONLY: 'Only admins can start games in this group.',
  GAME_WRONG_CHAT: 'This game was made from another chat\'s messages, so it can only be played there.',
  TOO_MANY_GAMES: 'You have saved the maximum number of games. Delete one to save another.',
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
  INVALID_GAME: 400,
  UNKNOWN_GAME: 404,
  GAME_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  ACCESS_DENIED: 403,
  USER_BLOCKED: 403,
  ADMINS_ONLY: 403,
  GAME_WRONG_CHAT: 403,
  GAME_UNAVAILABLE: 403,
  NOT_HOST: 403,
  RATE_LIMITED: 429,
};

const statusFor = (error) => STATUS[error?.code] || 409;

module.exports = { GameError, MESSAGES, statusFor };
