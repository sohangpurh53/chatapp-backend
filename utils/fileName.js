/**
 * Clients build local paths from a message's fileName, so a name must never
 * carry directories ("../../databases/x"). Keeps only the last path segment;
 * ordinary names pass through untouched.
 */
const safeFileName = (name) => {
  if (typeof name !== 'string') return name;
  const base = name.replace(/\0/g, '').split(/[\\/]/).pop();
  return !base || /^\.+$/.test(base) ? 'file' : base;
};

module.exports = { safeFileName };
