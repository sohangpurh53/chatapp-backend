/**
 * Checks a Google idToken the way POST /api/auth/google does, without logging in.
 *
 *   node scripts/verify-google-token.js            # takes the latest idToken from `adb logcat`
 *   node scripts/verify-google-token.js <idToken>
 *   node scripts/verify-google-token.js --server   # also POST it to the deployed /api/auth/google
 *
 * The app logs the token as `[DEBUG] GoogleSignin.signIn() response` after a sign-in.
 * Tokens expire after 1 hour.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execSync } = require('child_process');
const { OAuth2Client } = require('google-auth-library');

const SERVER = process.env.VERIFY_SERVER_URL || 'https://socket-chatapp.wesolves.online/api';
const args = process.argv.slice(2);
const hitServer = args.includes('--server');

const readTokenFromLogcat = () => {
  const log = execSync('adb logcat -d', { maxBuffer: 64 * 1024 * 1024 }).toString();
  const matches = [...log.matchAll(/"idToken":"([^"]+)"/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
};

const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

const main = async () => {
  const idToken = args.find((a) => !a.startsWith('--')) || readTokenFromLogcat();
  if (!idToken) {
    console.error('No idToken given and none found in adb logcat. Sign in with Google on the phone first.');
    process.exit(1);
  }

  const claims = decode(idToken);
  const clientId = process.env.GOOGLE_CLIENT_ID;
  console.log('Token aud (must be the Web client):', claims.aud);
  console.log('Token azp (the Android client):    ', claims.azp);
  console.log('Account:', claims.email, '| expires:', new Date(claims.exp * 1000).toLocaleString());
  console.log('.env GOOGLE_CLIENT_ID:              ', clientId);

  try {
    await new OAuth2Client().verifyIdToken({ idToken, audience: clientId });
    console.log('\n✅ Local check passed: a server with this GOOGLE_CLIENT_ID accepts the token.');
  } catch (err) {
    console.log('\n❌ Local check failed:', err.message);
    if (claims.aud !== clientId) console.log(`   Set GOOGLE_CLIENT_ID=${claims.aud}`);
    process.exitCode = 1;
  }

  if (hitServer) {
    // This is a real login: the server creates the user if needed and starts a session.
    const res = await fetch(`${SERVER}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const body = await res.json().catch(() => ({}));
    console.log(`\nDeployed server (${SERVER}): HTTP ${res.status}`, body.error || (body.user ? `logged in as ${body.user.email}` : ''));
    if (res.status === 401) console.log('   The deployed GOOGLE_CLIENT_ID does not match the token aud above.');
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
