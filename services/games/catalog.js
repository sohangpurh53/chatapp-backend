// The games ChatApp offers. Every game here is round based: each round shows one
// prompt with a few options, the server holds the answer and the clock, and scores
// are worked out on the server when the round closes.
const trivia = require('./content/trivia');
const emojiPuzzle = require('./content/emojiPuzzle');
const wouldYouRather = require('./content/wouldYouRather');

// Points for a correct answer: a base plus a speed bonus that shrinks to nothing
// as the round clock runs out (the time is measured on the server)
const BASE_POINTS = 500;
const SPEED_POINTS = 500;

const speedScore = (prompt, choice, elapsedMs, roundMs) => {
  if (choice !== prompt.correctIndex) return 0;
  const left = Math.max(0, Math.min(1, 1 - elapsedMs / roundMs));
  return BASE_POINTS + Math.round(SPEED_POINTS * left);
};

const GAMES = {
  quick_trivia: {
    id: 'quick_trivia',
    name: 'Quick Trivia',
    tagline: 'Fast questions, faster fingers.',
    description: 'Five general-knowledge questions. Answer correctly and quickly to score more.',
    category: 'trivia',
    minPlayers: 2,
    maxPlayers: 8,
    rounds: 5,
    roundMs: 15000,
    scored: true,
    estimatedMinutes: 2,
    bank: trivia,
    score: speedScore,
  },
  emoji_puzzle: {
    id: 'emoji_puzzle',
    name: 'Emoji Puzzle',
    tagline: 'Crack the clue before your friends do.',
    description: 'Five emoji clues. Pick the phrase they spell out. Faster right answers score more.',
    category: 'puzzle',
    minPlayers: 2,
    maxPlayers: 8,
    rounds: 5,
    roundMs: 20000,
    scored: true,
    estimatedMinutes: 2,
    bank: emojiPuzzle,
    score: speedScore,
  },
  would_you_rather: {
    id: 'would_you_rather',
    name: 'Would You Rather?',
    tagline: 'No right answers. Just surprises.',
    description: 'Five tough choices. See how everyone split, with no scores and no winners.',
    category: 'casual',
    minPlayers: 2,
    maxPlayers: 8,
    rounds: 5,
    roundMs: 15000,
    scored: false,
    estimatedMinutes: 2,
    bank: wouldYouRather,
    score: () => 0,
  },
  // Rules for games people make: each session brings its own prompts, so these
  // have no bank and never appear in the picker (see customGames.js)
  custom_quiz: {
    id: 'custom_quiz',
    name: 'Custom quiz',
    custom: true,
    category: 'trivia',
    minPlayers: 2,
    maxPlayers: 8,
    rounds: 5,
    roundMs: 20000,
    scored: true,
    bank: null,
    score: speedScore,
  },
  custom_poll: {
    id: 'custom_poll',
    name: 'Custom poll',
    custom: true,
    category: 'casual',
    minPlayers: 2,
    maxPlayers: 8,
    rounds: 5,
    roundMs: 20000,
    scored: false,
    bank: null,
    score: () => 0,
  },
};

// A game can be switched off (for example while its content is being fixed)
// without removing it from apps that already list it
const DISABLED = new Set(
  String(process.env.GAMES_DISABLED || '').split(',').map(s => s.trim()).filter(Boolean)
);

const getGame = (id) => (Object.prototype.hasOwnProperty.call(GAMES, id) ? GAMES[id] : null);

const isAvailable = (id) => !!getGame(id) && !DISABLED.has(id);

/** What apps show in the game picker: no question banks, no scoring rules. */
const publicCatalog = () => Object.values(GAMES).filter(game => !game.custom).map(game => ({
  id: game.id,
  name: game.name,
  tagline: game.tagline,
  description: game.description,
  category: game.category,
  minPlayers: game.minPlayers,
  maxPlayers: game.maxPlayers,
  rounds: game.rounds,
  roundSeconds: Math.round(game.roundMs / 1000),
  estimatedMinutes: game.estimatedMinutes,
  scored: game.scored,
  available: isAvailable(game.id),
}));

module.exports = { GAMES, getGame, isAvailable, publicCatalog, speedScore, BASE_POINTS, SPEED_POINTS };
