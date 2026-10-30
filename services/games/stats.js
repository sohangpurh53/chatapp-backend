// A player's numbers, from their own game results. Pure, no I/O.

const ACHIEVEMENTS = [
  { id: 'first_game', title: 'First game', description: 'Played a game', earned: (s) => s.played >= 1 },
  { id: 'first_win', title: 'First win', description: 'Won a game', earned: (s) => s.wins >= 1 },
  { id: 'regular', title: 'Regular', description: 'Played 10 games', earned: (s) => s.played >= 10 },
  { id: 'champion', title: 'Champion', description: 'Won 10 games', earned: (s) => s.wins >= 10 },
  { id: 'challenger', title: 'Challenge beaten', description: 'Beat a friend\'s score', earned: (s) => s.challengesWon >= 1 },
];

/** `results` newest first. */
const summarize = (results, { challengesCompleted = 0, challengesWon = 0 } = {}) => {
  const byGame = new Map();
  for (const r of results) {
    const game = byGame.get(r.gameType) || { gameType: r.gameType, gameName: r.gameName || r.gameType, played: 0, wins: 0, bestScore: 0 };
    game.played += 1;
    if (r.won) game.wins += 1;
    game.bestScore = Math.max(game.bestScore, r.score || 0);
    byGame.set(r.gameType, game);
  }
  const totals = {
    played: results.length,
    wins: results.filter(r => r.won).length,
    challengesCompleted,
    challengesWon,
  };
  return {
    totals,
    games: [...byGame.values()].sort((a, b) => b.played - a.played),
    achievements: ACHIEVEMENTS
      .map(({ id, title, description, earned }) => ({ id, title, description, earned: earned(totals) })),
  };
};

/** Standings for one chat, best first. `members` already leaves out anyone who opted out. */
const leaderboard = (results, members) => {
  const rows = new Map(members.map(m => [m.userId, { userId: m.userId, username: m.username, played: 0, wins: 0, bestScore: 0 }]));
  for (const r of results) {
    const row = rows.get(r.userId);
    if (!row) continue;
    row.played += 1;
    if (r.won) row.wins += 1;
    row.bestScore = Math.max(row.bestScore, r.score || 0);
  }
  return [...rows.values()]
    .filter(r => r.played > 0)
    .sort((a, b) => b.wins - a.wins || b.bestScore - a.bestScore);
};

module.exports = { ACHIEVEMENTS, summarize, leaderboard };
