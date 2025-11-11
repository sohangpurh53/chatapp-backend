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