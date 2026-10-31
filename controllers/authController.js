const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { User, EncryptionSession, Chat, ChatParticipant, GroupChatKey } = require('../models');
const { Op } = require('sequelize');
const encryptionService = require('../services/encryptionService');
const sessionService = require('../services/sessionService');
const { normalizeEmail, emailMatches } = require('../utils/email');
const passwordReset = require('../services/passwordReset');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// `sid` ties both tokens to a UserSession row, so a device can be signed out remotely
const generateToken = (userId, sid) => {
  return jwt.sign({ userId, ...(sid && { sid }) }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const generateRefreshToken = (userId, sid) => {
  return jwt.sign({ userId, type: 'refresh', ...(sid && { sid }) }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + '_refresh', { expiresIn: '30d' });
};

const register = async (req, res) => {
  try {
    const { password, publicKey, encryptedPrivateKey, keySalt, keyIv } = req.body;
    const email = normalizeEmail(req.body.email);
    const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
    const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';

    console.log('📥 Registration request received:', {
      firstName,
      lastName,
      email,
      hasPassword: !!password,
      hasPublicKey: !!publicKey,
      hasEncryptedPrivateKey: !!encryptedPrivateKey,
      hasKeySalt: !!keySalt,
      hasKeyIv: !!keyIv
    });

    // Validate input
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({
        error: 'First name, last name, email, and password are required'
      });
    }

    if (firstName.length > 50 || lastName.length > 50) {
      return res.status(400).json({
        error: 'Names must be 50 characters or fewer'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long'
      });
    }

    // Check if user already exists (email compared ignoring case)
    const existingUser = await User.findOne({ where: emailMatches(email) });

    if (existingUser) {
      return res.status(400).json({
        error: 'User with this email already exists'
      });
    }

    // The signup form has no username: derive a unique one, as Google sign-in does
    const username = await generateUsernameFromEmail(email);

    // Create new user with encryption keys
    const userData = {
      username,
      firstName,
      lastName,
      email,
      password,
      keyVersion: 1,
      keyCreatedAt: new Date()
    };

    // Add encryption keys if provided
    if (publicKey && encryptedPrivateKey && keySalt) {
      userData.publicKey = publicKey;
      userData.encryptedPrivateKey = encryptedPrivateKey;
      userData.keySalt = keySalt;
      userData.keyIv = keyIv; // Store IV for private key decryption
      userData.encryptionEnabled = true;
      
      console.log('🔐 User registered with encryption keys');
    }

    const user = await User.create(userData);

    const session = await sessionService.createSession(user.id, req);
    const token = generateToken(user.id, session.id);
    const refreshToken = generateRefreshToken(user.id, session.id);

    // Create encryption session if keys were provided
    let encryptionSession = null;
    if (user.encryptionEnabled) {
      try {
        encryptionSession = await encryptionService.createEncryptionSession(
          user.id,
          { userAgent: req.headers['user-agent'], ip: req.ip }
        );
      } catch (sessionError) {
        console.warn('Failed to create encryption session:', sessionError);
      }
    }

    res.status(201).json({
      message: 'User registered successfully',
      token,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        avatar: user.avatar,
        isOnline: user.isOnline,
        publicKey: user.publicKey,
        encryptionEnabled: user.encryptionEnabled,
        hasKeyBackup: !!user.encryptedPrivateKey
      },
      encryptionSession
    });
  } catch (error) {
    console.error('Registration error:', error);

    // Handle Sequelize validation errors
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({
        error: error.errors.map(e => e.message).join(', ')
      });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email (ignoring case)
    const user = await User.findOne({ where: emailMatches(email) });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Validate password
    const isValidPassword = await user.validatePassword(password);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update user online status
    await user.update({ isOnline: true, lastSeen: new Date() });

    const session = await sessionService.createSession(user.id, req);
    const token = generateToken(user.id, session.id);
    const refreshToken = generateRefreshToken(user.id, session.id);

    // Create encryption session if user has encryption enabled
    let encryptionSession = null;
    if (user.encryptionEnabled) {
      try {
        encryptionSession = await encryptionService.createEncryptionSession(
          user.id,
          { userAgent: req.headers['user-agent'], ip: req.ip }
        );
      } catch (sessionError) {
        console.warn('Failed to create encryption session:', sessionError);
      }
    }

    res.json({
      message: 'Login successful',
      token,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        isOnline: user.isOnline,
        publicKey: user.publicKey,
        encryptionEnabled: user.encryptionEnabled,
        hasKeyBackup: !!user.encryptedPrivateKey
      },
      encryptionSession
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Generates a unique username from a Google account's email local-part,
 * appending a numeric suffix if the base is already taken.
 */
const generateUsernameFromEmail = async (email) => {
  const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
  let candidate = base;
  let suffix = 0;

  while (await User.findOne({ where: { username: candidate } })) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
};

const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error('Google idToken verification failed:', verifyError);
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = payload;
    const googleNames = splitGoogleNames(payload);

    if (!email) {
      return res.status(400).json({ error: 'Google account has no email' });
    }

    // Find by googleId first, then fall back to linking an existing
    // email/password account that signs in with Google for the first time.
    let user = await User.findOne({ where: { googleId } });

    if (!user) {
      user = await User.findOne({ where: emailMatches(email) });

      if (user) {
        if (!user.googleId) {
          await user.update({ googleId });
        }
      } else {
        const username = await generateUsernameFromEmail(email);
        user = await User.create({
          username,
          email: normalizeEmail(email),
          password: null,
          authProvider: 'google',
          googleId,
          avatar: picture || null,
          ...googleNames,
        });
      }
    }

    // Names Google knows fill the gaps only: ones the user typed themselves are kept
    const missingNames = {};
    for (const key of ['firstName', 'middleName', 'lastName']) {
      if (!user[key] && googleNames[key]) missingNames[key] = googleNames[key];
    }
    await user.update({ isOnline: true, lastSeen: new Date(), ...missingNames });

    const session = await sessionService.createSession(user.id, req);
    const token = generateToken(user.id, session.id);
    const refreshToken = generateRefreshToken(user.id, session.id);

    let encryptionSession = null;
    if (user.encryptionEnabled) {
      try {
        encryptionSession = await encryptionService.createEncryptionSession(
          user.id,
          { userAgent: req.headers['user-agent'], ip: req.ip }
        );
      } catch (sessionError) {
        console.warn('Failed to create encryption session:', sessionError);
      }
    }

    res.json({
      message: 'Login successful',
      token,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        isOnline: user.isOnline,
        publicKey: user.publicKey,
        encryptionEnabled: user.encryptionEnabled,
        hasKeyBackup: !!user.encryptedPrivateKey,
      },
      encryptionSession,
    });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /auth/vibes {userIds: string[]} -> { vibes: { [userId]: vibe } } (unexpired only)
 */
const getVibes = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.userIds) ? req.body.userIds.filter(id => typeof id === 'string').slice(0, 200) : [];
    if (ids.length === 0) {
      return res.json({ vibes: {} });
    }

    const users = await User.findAll({
      where: { id: { [Op.in]: ids } },
      attributes: ['id', 'vibe']
    });

    const now = Date.now();
    const vibes = {};
    users.forEach(u => {
      if (u.vibe && u.vibe.expiresAt && new Date(u.vibe.expiresAt).getTime() > now) {
        vibes[u.id] = u.vibe;
      }
    });

    res.json({ vibes });
  } catch (error) {
    console.error('Get vibes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const logout = async (req, res) => {
  try {
    await req.user.update({ lastSeen: new Date() });

    // Sign out this device only; the user's other devices stay signed in. Online status
    // follows their sockets: another device may still be connected
    if (req.sessionId) {
      await sessionService.revokeById(req.user.id, req.sessionId, 'logout');
    }

    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const { visibleDetails, normalizePrivacy, parseDetailsUpdate, PRIVATE_FIELDS } = require('../utils/profilePrivacy');
const { blockState } = require('../utils/blocks');

// Google sends given_name ("Anna Maria") and family_name ("Smith"), not a middle name:
// the first word of the given name is the first name, the rest the middle name.
const splitGoogleNames = (payload) => {
  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 50) : '') || null;
  let given = typeof payload.given_name === 'string' ? payload.given_name.trim() : '';
  let family = typeof payload.family_name === 'string' ? payload.family_name.trim() : '';
  if (!given && !family && typeof payload.name === 'string') {
    const parts = payload.name.trim().split(/\s+/).filter(Boolean);
    given = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '';
    family = parts.length > 1 ? parts[parts.length - 1] : '';
  }
  const [first, ...middle] = given.split(/\s+/).filter(Boolean);
  return { firstName: clean(first), middleName: clean(middle.join(' ')), lastName: clean(family) };
};

const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'username', 'email', 'avatar', 'isOnline', 'lastSeen', 'publicKey', 'encryptionEnabled', 'encryptedPrivateKey',
        ...PRIVATE_FIELDS, 'profilePrivacy']
    });

    // hasKeyBackup tells the app whether a password can unlock this account's keys
    const { encryptedPrivateKey, profilePrivacy, ...profile } = user.toJSON();
    res.json({ user: { ...profile, profilePrivacy: normalizePrivacy(profilePrivacy), hasKeyBackup: !!encryptedPrivateKey } });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add endpoint to get user's public key
const getUserPublicKey = async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await User.findByPk(userId, {
      attributes: ['id', 'username', 'publicKey', 'encryptionEnabled']
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // The public key alone decides: rows saved by an older version could have a key
    // but encryptionEnabled false (keys without a password backup)
    if (!user.publicKey) {
      return res.status(404).json({ error: 'User does not have encryption enabled' });
    }

    res.json({
      userId: user.id,
      username: user.username,
      publicKey: user.publicKey
    });
  } catch (error) {
    console.error('Get public key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Enhanced upload/update encryption keys with validation
const uploadKeys = async (req, res) => {
  try {
    const { publicKey, encryptedPrivateKey, keySalt, keyIv } = req.body;
    const userId = req.user.id;
    
    if (!publicKey || !encryptedPrivateKey || !keySalt) {
      return res.status(400).json({ error: 'Missing required key data' });
    }

    // Validate key format (basic validation)
    if (publicKey.length < 100 || encryptedPrivateKey.length < 100) {
      return res.status(400).json({ error: 'Invalid key format' });
    }
    
    const currentUser = await User.findByPk(userId);
    const isFirstTimeSetup = !currentUser.encryptionEnabled;
    
    if (isFirstTimeSetup) {
      // First time setup
      await currentUser.update({
        publicKey,
        encryptedPrivateKey,
        keySalt,
        keyIv: keyIv || keySalt, // Store IV, fallback to keySalt for backward compatibility
        keyCreatedAt: new Date(),
        encryptionEnabled: true
      });
    } else {
      // Key rotation
      await currentUser.rotateKeys(publicKey, encryptedPrivateKey, keySalt, keyIv);
    }

    // Create new encryption session
    const encryptionSession = await encryptionService.createEncryptionSession(
      userId,
      { userAgent: req.headers['user-agent'], ip: req.ip }
    );
    
    res.json({ 
      success: true, 
      message: isFirstTimeSetup ? 'Keys uploaded successfully' : 'Keys rotated successfully',
      keyVersion: currentUser.keyVersion,
      encryptionSession
    });
  } catch (error) {
    console.error('Upload keys error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Enhanced get encrypted private key with session validation
/**
 * First-time encryption setup for an account that has no keys yet (a Google-only
 * account): the phone makes the key pair and keeps the private key itself, the
 * server only stores the public key. Refuses once keys exist, so it can never
 * replace a key other people already encrypt to.
 */
const registerDeviceKey = async (req, res) => {
  try {
    const { publicKey } = req.body;

    if (typeof publicKey !== 'string' || publicKey.length < 100 || publicKey.length > 4096) {
      return res.status(400).json({ error: 'Invalid key format' });
    }

    const currentUser = await User.findByPk(req.user.id);
    if (currentUser.encryptionEnabled) {
      return res.status(409).json({ error: 'Encryption is already set up for this account' });
    }

    await currentUser.update({
      publicKey,
      keyVersion: 1,
      keyCreatedAt: new Date(),
      encryptionEnabled: true
    });

    res.json({
      success: true,
      user: { publicKey: currentUser.publicKey, encryptionEnabled: true, hasKeyBackup: false }
    });
  } catch (error) {
    console.error('Register device key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * After a user's key pair is replaced, the group keys addressed to the old public key
 * are useless: drop them and flag each group so the next member who sends rotates the
 * key for everyone, the new public key included. Old sessions for the old key end too.
 */
const retireOldKeyCopies = async (userId) => {
  await EncryptionSession.update({ isActive: false }, { where: { userId } });
  const memberships = await ChatParticipant.findAll({ where: { userId, isActive: true }, attributes: ['chatId'] });
  const groups = memberships.length
    ? await Chat.findAll({ where: { id: memberships.map(m => m.chatId), isGroup: true } })
    : [];
  for (const group of groups) {
    await GroupChatKey.destroy({ where: { chatId: group.id, userId } });
    await group.update({ settings: { ...(group.settings || {}), keyRotationNeeded: true } });
  }
};

/**
 * POST /auth/device-key/reset {publicKey, idToken}: "Start fresh" for an account whose
 * keys only ever lived on a phone it no longer has (Google signup, then a reinstall, a
 * new phone or a remote sign-out). The phone made a new pair; the server swaps in the
 * public key. A fresh Google sign-in is required, so a stolen app session alone cannot
 * swap the keys and read what people send next. Accounts with a password backup are
 * refused: their password unlocks the existing keys and keeps their old messages.
 */
const resetDeviceKey = async (req, res) => {
  try {
    const { publicKey, idToken } = req.body;

    if (typeof publicKey !== 'string' || publicKey.length < 100 || publicKey.length > 4096) {
      return res.status(400).json({ error: 'Invalid key format' });
    }
    if (typeof idToken !== 'string' || !idToken) {
      return res.status(400).json({ error: 'Confirm with your Google account first', code: 'GOOGLE_CONFIRMATION_REQUIRED' });
    }

    const user = await User.findByPk(req.user.id);
    if (user.encryptedPrivateKey) {
      return res.status(409).json({
        error: 'Your ChatApp password unlocks your existing keys and keeps your messages',
        code: 'HAS_PASSWORD_BACKUP'
      });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
      payload = ticket.getPayload();
    } catch (verifyError) {
      return res.status(401).json({ error: 'Google confirmation failed. Try again.', code: 'GOOGLE_CONFIRMATION_FAILED' });
    }
    if (!user.googleId || payload.sub !== user.googleId) {
      return res.status(403).json({ error: 'Confirm with the Google account this ChatApp account uses', code: 'GOOGLE_ACCOUNT_MISMATCH' });
    }

    await user.rotateKeys(publicKey, null, null, null);
    await retireOldKeyCopies(user.id);

    res.json({ success: true, user: { publicKey: user.publicKey, encryptionEnabled: true, hasKeyBackup: false } });
  } catch (error) {
    console.error('Reset device key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /auth/forgot-password {email}: emails a one-time code. Always answers the
 * same, so it can't be used to find out which addresses have an account.
 */
const forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    try {
      await passwordReset.requestReset(email);
    } catch (sendError) {
      // Not the caller's business (and not a hint about the account): log and carry on
      console.error('Password reset request failed:', sendError);
    }

    res.json({ message: 'If an account exists for that email, a reset code has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * POST /auth/reset-password {email, code, newPassword, publicKey?, encryptedPrivateKey?, keySalt?, keyIv?}
 *
 * The old password also locked the private key. When the phone still has the account's
 * keys it sends the SAME public key re-locked with the new password: nothing is lost.
 * Otherwise it sends a brand-new key pair and older encrypted messages stay unreadable. Group keys addressed to the old public
 * key are dropped and the groups flagged so the next member who sends rotates the
 * key for everyone, including the new one. Every signed-in device is signed out.
 */
const resetPassword = async (req, res) => {
  try {
    const { code, newPassword, publicKey, encryptedPrivateKey, keySalt, keyIv } = req.body;
    const invalidCode = () => res.status(400).json({
      error: 'That code is invalid or has expired. Request a new one.',
      code: 'INVALID_RESET_CODE'
    });

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const user = await User.findOne({ where: emailMatches(req.body.email) });
    // Same answer as a wrong code, so this can't be used to probe for accounts
    if (!user || !user.password) {
      return invalidCode();
    }

    const reset = await passwordReset.verifyCode(user.id, code);
    if (!reset) {
      return invalidCode();
    }

    // The code is proven, so it is safe to be specific from here on (the code is not spent yet)
    const hasKeys = !!(publicKey && encryptedPrivateKey && keySalt);
    if (hasKeys && (publicKey.length < 100 || encryptedPrivateKey.length < 100)) {
      return res.status(400).json({ error: 'Invalid key format' });
    }
    if (user.encryptionEnabled && !hasKeys) {
      return res.status(400).json({ error: 'New encryption keys are required', code: 'KEYS_REQUIRED' });
    }

    await user.update({ password: newPassword });

    // The phone still had this account's keys and re-locked them with the new password:
    // same key pair, so only the backup changes and every old message stays readable
    const keysKept = hasKeys && !!user.publicKey && publicKey === user.publicKey;
    if (keysKept) {
      await user.update({ encryptedPrivateKey, keySalt, keyIv: keyIv || keySalt });
    } else if (hasKeys) {
      await user.rotateKeys(publicKey, encryptedPrivateKey, keySalt, keyIv);
      await retireOldKeyCopies(user.id);
    }

    await sessionService.revokeOthers(user.id, null);
    await passwordReset.useUp(reset);

    res.json({ success: true, userId: user.id, keysReplaced: hasKeys && !keysKept, keysKept });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getEncryptedPrivateKey = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findByPk(userId, {
      attributes: ['encryptedPrivateKey', 'keySalt', 'keyIv', 'keyVersion', 'encryptionEnabled']
    });
    
    if (!user || !user.encryptionEnabled || !user.encryptedPrivateKey) {
      return res.status(404).json({ error: 'Encryption keys not found' });
    }
    
    res.json({
      encryptedPrivateKey: user.encryptedPrivateKey,
      keySalt: user.keySalt,
      keyIv: user.keyIv || user.keySalt, // Fallback to keySalt for backward compatibility
      keyVersion: user.keyVersion
    });
  } catch (error) {
    console.error('Get encrypted private key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ✅ NEW: Get user info by ID (for call participant details)
const getUserInfo = async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Basic validation
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    const user = await User.findByPk(userId, {
      attributes: ['id', 'username', 'avatar', 'isOnline', 'lastSeen', 'createdAt', ...PRIVATE_FIELDS, 'profilePrivacy']
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const viewerId = req.user.id;
    const { blockedByMe, blockedByThem } = await blockState(viewerId, user.id);
    // Someone who blocked you looks like anyone who keeps their presence and details
    // private; nothing here tells you that you were blocked.
    const hidden = blockedByThem;
    const details = hidden ? {} : await visibleDetails(user, viewerId);

    res.json({
      data: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        isOnline: hidden ? false : user.isOnline,
        lastSeen: hidden ? null : user.lastSeen,
        joinedAt: user.createdAt,
        details,
        blockedByMe,
        isBlocked: blockedByMe
      }
    });
  } catch (error) {
    console.error('Get user info error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { username, email, avatar } = req.body;
    const userId = req.user.id;

    const details = parseDetailsUpdate(req.body);
    if (details.error) {
      return res.status(400).json({ error: details.error });
    }
    const { profilePrivacyPatch, ...detailFields } = details.data;
    const hasDetails = Object.keys(detailFields).length > 0 || !!profilePrivacyPatch;

    // Validate input
    if (!username && !email && avatar === undefined && !hasDetails) {
      return res.status(400).json({
        error: 'At least one field (username, avatar, or personal details) is required'
      });
    }

    // Prepare update data
    const updateData = {};
    
    if (username) {
      if (username.trim().length < 2) {
        return res.status(400).json({
          error: 'Username must be at least 2 characters long'
        });
      }
      
      // Check if username is already taken by another user
      const existingUser = await User.findOne({
        where: {
          username: username.trim(),
          id: { [Op.ne]: userId }
        }
      });
      
      if (existingUser) {
        return res.status(400).json({
          error: 'Username is already taken'
        });
      }
      
      updateData.username = username.trim();
    }

    // Email is the sign-in identity and can't be changed here. Older app builds
    // still send the current one with every save, so only a different one is refused.
    if (email) {
      const current = await User.findByPk(userId, { attributes: ['email'] });
      if (!current || normalizeEmail(current.email) !== normalizeEmail(email)) {
        return res.status(400).json({
          error: 'Email cannot be changed'
        });
      }
    }

    if (avatar !== undefined) {
      updateData.avatar = avatar;
    }

    Object.assign(updateData, detailFields);
    if (profilePrivacyPatch) {
      const current = await User.findByPk(userId, { attributes: ['profilePrivacy'] });
      updateData.profilePrivacy = { ...normalizePrivacy(current?.profilePrivacy), ...profilePrivacyPatch };
    }

    // Update user profile
    await User.update(updateData, {
      where: { id: userId }
    });

    // Get updated user data
    const updatedUser = await User.findByPk(userId, {
      attributes: ['id', 'username', 'email', 'avatar', 'isOnline', 'lastSeen', 'publicKey', 'encryptionEnabled', 'encryptedPrivateKey',
        ...PRIVATE_FIELDS, 'profilePrivacy']
    });

    res.json({
      message: 'Profile updated successfully',
      user: {
        ...Object.fromEntries(PRIVATE_FIELDS.map(f => [f, updatedUser[f]])),
        profilePrivacy: normalizePrivacy(updatedUser.profilePrivacy),
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        avatar: updatedUser.avatar,
        isOnline: updatedUser.isOnline,
        publicKey: updatedUser.publicKey,
        encryptionEnabled: updatedUser.encryptionEnabled,
        hasKeyBackup: !!updatedUser.encryptedPrivateKey
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);
    
    // Handle Sequelize validation errors
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({
        error: error.errors.map(e => e.message).join(', ')
      });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Enhanced update keys with proper rotation tracking
const updateKeys = async (req, res) => {
  try {
    const { publicKey, encryptedPrivateKey, keySalt, keyIv } = req.body;
    const userId = req.user.id;
    
    if (!publicKey || !encryptedPrivateKey || !keySalt) {
      return res.status(400).json({ error: 'Missing required key data' });
    }
    
    const currentUser = await User.findByPk(userId);
    
    // Use the rotateKeys method for proper tracking
    await currentUser.rotateKeys(publicKey, encryptedPrivateKey, keySalt, keyIv);
    
    // Create new encryption session
    const encryptionSession = await encryptionService.createEncryptionSession(
      userId,
      { userAgent: req.headers['user-agent'], ip: req.ip }
    );
    
    res.json({ 
      success: true, 
      message: 'Keys updated successfully',
      keyVersion: currentUser.keyVersion + 1,
      encryptionSession
    });
  } catch (error) {
    console.error('Update keys error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// NEW: Validate encryption session
const validateEncryptionSession = async (req, res) => {
  try {
    const { sessionToken } = req.body;
    
    if (!sessionToken) {
      return res.status(400).json({ error: 'Session token is required' });
    }
    
    const validation = await encryptionService.validateEncryptionSession(sessionToken);
    
    if (!validation.valid) {
      return res.status(401).json({ error: validation.error });
    }
    
    res.json({
      valid: true,
      userId: validation.userId,
      keyVersion: validation.keyVersion
    });
  } catch (error) {
    console.error('Validate encryption session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// NEW: Get encryption statistics (admin only)
const getEncryptionStats = async (req, res) => {
  try {
    const stats = await encryptionService.getEncryptionStats();
    res.json(stats);
  } catch (error) {
    console.error('Get encryption stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// GET /auth/sessions: signed-in devices, current one first
const getSessions = async (req, res) => {
  try {
    const sessions = await sessionService.listSessions(req.user.id);
    const list = sessions
      .map(s => ({ ...s.toJSON(), isCurrent: s.id === req.sessionId }))
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    res.json({ sessions: list, maxSessions: sessionService.MAX_ACTIVE_SESSIONS, currentSessionId: req.sessionId || null });
  } catch (error) {
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to load devices' });
  }
};

// DELETE /auth/sessions/:sessionId: sign out another device
const revokeSession = async (req, res) => {
  try {
    if (req.params.sessionId === req.sessionId) {
      return res.status(400).json({ error: 'Use Log out to sign out of this device' });
    }
    const revoked = await sessionService.revokeById(req.user.id, req.params.sessionId, 'remote');
    if (!revoked) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Revoke session error:', error);
    res.status(500).json({ error: 'Failed to sign out device' });
  }
};

// POST /auth/sessions/revoke-others: sign out every device except this one
const revokeOtherSessions = async (req, res) => {
  try {
    const count = await sessionService.revokeOthers(req.user.id, req.sessionId);
    res.json({ success: true, revokedCount: count });
  } catch (error) {
    console.error('Revoke other sessions error:', error);
    res.status(500).json({ error: 'Failed to sign out other devices' });
  }
};

const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + '_refresh';

    let decoded;
    try {
      decoded = jwt.verify(token, REFRESH_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'REFRESH_TOKEN_EXPIRED' });
    }

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const user = await User.findByPk(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Signed out from another device: no new tokens. Older tokens without a
    // session are moved onto one now, so they can be managed from then on.
    let sid = decoded.sid;
    if (sid) {
      if (!(await sessionService.validateSession(sid, user.id))) {
        return res.status(401).json({ error: 'This device was signed out', code: 'SESSION_REVOKED' });
      }
    } else {
      sid = (await sessionService.createSession(user.id, req)).id;
    }

    const newAccessToken = generateToken(user.id, sid);
    const newRefreshToken = generateRefreshToken(user.id, sid);

    res.json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  splitGoogleNames,
  register,
  login,
  googleLogin,
  getVibes,
  logout,
  refreshToken,
  getSessions,
  revokeSession,
  revokeOtherSessions,
  getProfile,
  updateProfile,
  getUserPublicKey,
  getUserInfo,
  uploadKeys,
  registerDeviceKey,
  resetDeviceKey,
  forgotPassword,
  resetPassword,
  getEncryptedPrivateKey,
  updateKeys,
  validateEncryptionSession,
  getEncryptionStats
};