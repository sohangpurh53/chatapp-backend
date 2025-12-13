const Redis = require('ioredis');
require('dotenv').config();

class RedisService {
  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });

    this.client.on('connect', () => {
      console.log('✅ Redis connected successfully');
    });

    this.client.on('error', (err) => {
      console.error('❌ Redis connection error:', err);
    });
  }

  // Cache user sessions
  async setUserSession(userId, sessionData, ttl = 86400) {
    try {
      await this.client.setex(`user:${userId}`, ttl, JSON.stringify(sessionData));
    } catch (error) {
      console.error('Redis setUserSession error:', error);
    }
  }

  async getUserSession(userId) {
    try {
      const data = await this.client.get(`user:${userId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getUserSession error:', error);
      return null;
    }
  }

  async deleteUserSession(userId) {
    try {
      await this.client.del(`user:${userId}`);
    } catch (error) {
      console.error('Redis deleteUserSession error:', error);
    }
  }

  // Cache chat data
  async setChatData(chatId, chatData, ttl = 3600) {
    try {
      await this.client.setex(`chat:${chatId}`, ttl, JSON.stringify(chatData));
    } catch (error) {
      console.error('Redis setChatData error:', error);
    }
  }

  async getChatData(chatId) {
    try {
      const data = await this.client.get(`chat:${chatId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getChatData error:', error);
      return null;
    }
  }

  // Store active calls
  async setActiveCall(callId, callData, ttl = 7200) {
    try {
      await this.client.setex(`call:${callId}`, ttl, JSON.stringify(callData));
    } catch (error) {
      console.error('Redis setActiveCall error:', error);
    }
  }

  async getActiveCall(callId) {
    try {
      const data = await this.client.get(`call:${callId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getActiveCall error:', error);
      return null;
    }
  }

  async deleteActiveCall(callId) {
    try {
      await this.client.del(`call:${callId}`);
    } catch (error) {
      console.error('Redis deleteActiveCall error:', error);
    }
  }

  // Store user call status
  async setUserCallStatus(userId, callId, status) {
    try {
      await this.client.setex(`user_call:${userId}`, 7200, JSON.stringify({ callId, status }));
    } catch (error) {
      console.error('Redis setUserCallStatus error:', error);
    }
  }

  async getUserCallStatus(userId) {
    try {
      const data = await this.client.get(`user_call:${userId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Redis getUserCallStatus error:', error);
      return null;
    }
  }

  async deleteUserCallStatus(userId) {
    try {
      await this.client.del(`user_call:${userId}`);
    } catch (error) {
      console.error('Redis deleteUserCallStatus error:', error);
    }
  }

  // Pending signals storage (for offline delivery)
  async pushPendingSignal(targetUserId, callId, signal, ttl = 300) {
    try {
      const key = `pending_signals:${targetUserId}:${callId}`;
      
      // ✅ Enhanced signal storage with validation
      const signalWithMetadata = {
        ...signal,
        storedAt: Date.now(),
        expiresAt: Date.now() + (ttl * 1000)
      };

      await this.client.rpush(key, JSON.stringify(signalWithMetadata));
      await this.client.expire(key, ttl); // 5 minutes TTL for calls
      
      // ✅ Also maintain user pending signals index
      const userIndexKey = `user_pending_signals:${targetUserId}`;
      await this.client.sadd(userIndexKey, callId);
      await this.client.expire(userIndexKey, ttl);
      
      console.log(`💾 Signal ${signal.type} stored for user ${targetUserId}, call ${callId} (TTL: ${ttl}s)`);
    } catch (error) {
      console.error('Redis pushPendingSignal error:', error);
    }
  }

  async getPendingSignalsForUser(userId) {
    try {
      const keys = await this.client.keys(`pending_signals:${userId}:*`);
      const all = {};
      const now = Date.now();
      
      for (const key of keys) {
        const callId = key.split(':').pop();
        const items = await this.client.lrange(key, 0, -1);
        
        // ✅ Filter out expired signals
        const validSignals = items
          .map(i => JSON.parse(i))
          .filter(signal => {
            if (signal.expiresAt && signal.expiresAt < now) {
              console.log(`🗑️  Filtering expired signal for call ${callId}`);
              return false;
            }
            return true;
          });
        
        if (validSignals.length > 0) {
          all[callId] = validSignals;
        } else {
          // Clean up empty/expired signal list
          await this.client.del(key);
        }
      }
      
      return all; // { callId: [signal, ...] }
    } catch (error) {
      console.error('Redis getPendingSignalsForUser error:', error);
      return {};
    }
  }

  async deletePendingSignals(userId, callId) {
    try {
      const key = `pending_signals:${userId}:${callId}`;
      await this.client.del(key);
      
      // ✅ Also remove from user index
      const userIndexKey = `user_pending_signals:${userId}`;
      await this.client.srem(userIndexKey, callId);
      
      console.log(`🗑️  Deleted pending signals for user ${userId}, call ${callId}`);
    } catch (error) {
      console.error('Redis deletePendingSignals error:', error);
    }
  }

  /**
   * ✅ NEW: Validate SDP offer format
   */
  validateSignalData(signal) {
    if (!signal || typeof signal !== 'object') {
      return { valid: false, error: 'Signal must be an object' };
    }

    if (!signal.type || !['offer', 'answer', 'ice-candidate'].includes(signal.type)) {
      return { valid: false, error: 'Invalid signal type' };
    }

    if (signal.type === 'offer' || signal.type === 'answer') {
      if (!signal.sdp || typeof signal.sdp !== 'string') {
        return { valid: false, error: 'SDP data is required for offer/answer' };
      }
      
      // Basic SDP validation
      if (!signal.sdp.includes('v=0') || !signal.sdp.includes('m=')) {
        return { valid: false, error: 'Invalid SDP format' };
      }
    }

    if (signal.type === 'ice-candidate') {
      if (!signal.candidate && signal.candidate !== null) {
        return { valid: false, error: 'ICE candidate data is required' };
      }
    }

    return { valid: true };
  }

  /**
   * ✅ NEW: Cleanup expired signals (run periodically)
   */
  async cleanupExpiredSignals() {
    try {
      const pattern = 'pending_signals:*';
      const keys = await this.client.keys(pattern);
      let cleanedCount = 0;
      
      for (const key of keys) {
        const ttl = await this.client.ttl(key);
        if (ttl === -1 || ttl === 0) {
          // Key has no TTL or is expired
          await this.client.del(key);
          cleanedCount++;
        }
      }
      
      // Also cleanup user indexes
      const userIndexKeys = await this.client.keys('user_pending_signals:*');
      for (const key of userIndexKeys) {
        const ttl = await this.client.ttl(key);
        if (ttl === -1 || ttl === 0) {
          await this.client.del(key);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} expired signal keys`);
      }
      
      return cleanedCount;
    } catch (error) {
      console.error('Redis cleanupExpiredSignals error:', error);
      return 0;
    }
  }

  // Cache recent messages
  async cacheMessage(chatId, message, ttl = 86400) {
    try {
      await this.client.lpush(`messages:${chatId}`, JSON.stringify(message));
      await this.client.expire(`messages:${chatId}`, ttl);
      await this.client.ltrim(`messages:${chatId}`, 0, 99); // Keep last 100 messages
    } catch (error) {
      console.error('Redis cacheMessage error:', error);
    }
  }

  async getCachedMessages(chatId, limit = 50) {
    try {
      const messages = await this.client.lrange(`messages:${chatId}`, 0, limit - 1);
      return messages.map(msg => JSON.parse(msg));
    } catch (error) {
      console.error('Redis getCachedMessages error:', error);
      return [];
    }
  }

  // Store online users
  async setUserOnline(userId, socketId) {
    try {
      await this.client.setex(`online:${userId}`, 300, socketId); // 5 minutes TTL
    } catch (error) {
      console.error('Redis setUserOnline error:', error);
    }
  }

  async getUserOnlineStatus(userId) {
    try {
      const socketId = await this.client.get(`online:${userId}`);
      return socketId !== null;
    } catch (error) {
      console.error('Redis getUserOnlineStatus error:', error);
      return false;
    }
  }

  async setUserOffline(userId) {
    try {
      await this.client.del(`online:${userId}`);
    } catch (error) {
      console.error('Redis setUserOffline error:', error);
    }
  }

  // Get all online users
  async getAllOnlineUsers() {
    try {
      const keys = await this.client.keys('online:*');
      return keys.map(key => key.replace('online:', ''));
    } catch (error) {
      console.error('Redis getAllOnlineUsers error:', error);
      return [];
    }
  }

  async disconnect() {
    await this.client.quit();
  }
}

module.exports = new RedisService();