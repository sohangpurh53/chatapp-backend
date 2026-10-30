// What a custom game may contain. Everything a player sees passes through here,
// whether it came from the AI model or from an app saving a game, so neither can
// put something into the engine that it can't run fairly. Pure, no I/O.
const { GameError } = require('./errors');

const LIMITS = {
  titleChars: 60,
  rulesChars: 300,
  briefChars: 500,
  questionChars: 220,
  optionChars: 80,
  minRounds: 3,
  maxRounds: 20,
  minOptions: 2,
  maxOptions: 4,
  minRoundSeconds: 10,
  maxRoundSeconds: 45,
  defaultRoundSeconds: 20,
  maxSavedGames: 50,
};

// quiz: options with a right answer, scored on speed. poll: no right answer.
const FORMATS = { quiz: 'custom_quiz', poll: 'custom_poll' };

const clean = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

const cleanRound = (raw, format, index) => {
  const question = clean(raw?.question, LIMITS.questionChars);
  if (!question || !Array.isArray(raw?.options)) return null;

  const original = raw.options.map(o => clean(o, LIMITS.optionChars));
  const options = [...new Set(original.filter(Boolean))].slice(0, LIMITS.maxOptions);
  if (options.length < LIMITS.minOptions) return null;

  let answer = null;
  if (format === 'quiz') {
    // Options may have moved (blanks and repeats removed): follow the text
    const right = Number.isInteger(raw.answer) ? original[raw.answer] : null;
    answer = right ? options.indexOf(right) : -1;
    if (answer < 0) return null;
  }
  return { id: `c${index + 1}`, question, options, answer };
};

/**
 * The cleaned game, or a GameError when too little of it is playable. Single bad
 * rounds are dropped and counted in `dropped`, so one mistake from the model
 * doesn't lose the rest.
 */
const validateGame = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GameError('INVALID_REQUEST');
  const format = Object.prototype.hasOwnProperty.call(FORMATS, input.format) ? input.format : null;
  const title = clean(input.title, LIMITS.titleChars);
  if (!format || !title || !Array.isArray(input.rounds)) throw new GameError('INVALID_GAME');

  const rounds = input.rounds
    .slice(0, LIMITS.maxRounds)
    .map((round, i) => cleanRound(round, format, i))
    .filter(Boolean);
  const seen = new Set();
  const unique = rounds.filter(r => {
    const key = r.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length < LIMITS.minRounds) throw new GameError('INVALID_GAME');

  const seconds = Math.round(Number(input.roundSeconds)) || LIMITS.defaultRoundSeconds;
  return {
    game: {
      title,
      format,
      rules: clean(input.rules, LIMITS.rulesChars),
      // Built from chat messages: holds real names, so AI may not change it later
      fromConversation: input.fromConversation === true,
      roundSeconds: Math.min(LIMITS.maxRoundSeconds, Math.max(LIMITS.minRoundSeconds, seconds)),
      rounds: unique.map((round, i) => ({ ...round, id: `c${i + 1}` })),
    },
    dropped: Math.min(input.rounds.length, LIMITS.maxRounds) - unique.length,
  };
};

/** A saved game as the content a session plays (see engine rulesOf). */
const toSessionContent = (game) => ({
  title: game.title,
  rules: game.rules || null,
  aiGenerated: true,
  roundSeconds: game.roundSeconds,
  rounds: game.rounds.length,
  prompts: game.rounds,
});

module.exports = { LIMITS, FORMATS, validateGame, toSessionContent };
