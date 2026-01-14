const jwt = require('jsonwebtoken');
const { User, EncryptionSession } = require('../models');
const { Op } = require('sequelize');
const encryptionService = require('../services/encryptionService');

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

const register = async (req, res) => {
  try {
    const { username, email, password, publicKey, encryptedPrivateKey, keySalt, keyIv } = req.body;

    console.log('📥 Registration request received:', {
      username,
      email,
      hasPassword: !!password,
      hasPublicKey: !!publicKey,
      hasEncryptedPrivateKey: !!encryptedPrivateKey,
      hasKeySalt: !!keySalt,
      hasKeyIv: !!keyIv
    });

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Username, email, and password are required'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      where: {
        [Op.or]: [{ email }, { username }]
      }
    });

    if (existingUser) {
      return res.status(400).json({
        error: 'User with this email or username already exists'
      });
    }

    // Create new user with encryption keys
    const userData = {
      username,
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

    const token = generateToken(user.id);

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
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        isOnline: user.isOnline,
        publicKey: user.publicKey,
        encryptionEnabled: user.encryptionEnabled
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

    // Find user by email
    const user = await User.findOne({ where: { email } });

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

    const token = generateToken(user.id);

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
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        isOnline: user.isOnline,
        publicKey: user.publicKey,
        encryptionEnabled: user.encryptionEnabled
      },
      encryptionSession
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const logout = async (req, res) => {
  try {
    await req.user.update({
      isOnline: false,
      lastSeen: new Date()
    });

    // Deactivate all encryption sessions for this user
    await EncryptionSession.update(
      { isActive: false },
      { where: { userId: req.user.id, isActive: true } }
    );

    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'username', 'email', 'avatar', 'isOnline', 'lastSeen', 'publicKey', 'encryptionEnabled']
    });

    res.json({ user });
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

    if (!user.encryptionEnabled || !user.publicKey) {
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
      attributes: ['id', 'username', 'avatar', 'isOnline', 'lastSeen']
    });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      data: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        isOnline: user.isOnline,
        lastSeen: user.lastSeen
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

    // Validate input
    if (!username && !email && avatar === undefined) {
      return res.status(400).json({
        error: 'At least one field (username, email, or avatar) is required'
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

    if (email) {
      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          error: 'Please enter a valid email address'
        });
      }
      
      // Check if email is already taken by another user
      const existingUser = await User.findOne({
        where: {
          email: email.trim().toLowerCase(),
          id: { [Op.ne]: userId }
        }
      });
      
      if (existingUser) {
        return res.status(400).json({
          error: 'Email is already taken'
        });
      }
      
      updateData.email = email.trim().toLowerCase();
    }

    if (avatar !== undefined) {
      updateData.avatar = avatar;
    }

    // Update user profile
    await User.update(updateData, {
      where: { id: userId }
    });

    // Get updated user data
    const updatedUser = await User.findByPk(userId, {
      attributes: ['id', 'username', 'email', 'avatar', 'isOnline', 'lastSeen', 'publicKey', 'encryptionEnabled']
    });

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        avatar: updatedUser.avatar,
        isOnline: updatedUser.isOnline,
        publicKey: updatedUser.publicKey,
        encryptionEnabled: updatedUser.encryptionEnabled
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

module.exports = {
  register,
  login,
  logout,
  getProfile,
  updateProfile,
  getUserPublicKey,
  getUserInfo,
  uploadKeys,
  getEncryptedPrivateKey,
  updateKeys,
  validateEncryptionSession,
  getEncryptionStats
};