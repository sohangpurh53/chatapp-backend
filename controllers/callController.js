const { Call, User } = require('../models');
const redisService = require('../config/redis');

class CallController {
  // Get call history for a user
  async getCallHistory(req, res) {
    try {
      const userId = req.user.id;
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const calls = await Call.findAndCountAll({
        where: {
          [require('sequelize').Op.or]: [
            { callerId: userId },
            { receiverId: userId }
          ]
        },
        include: [
          {
            model: User,
            as: 'caller',
            attributes: ['id', 'username', 'avatar']
          },
          {
            model: User,
            as: 'receiver',
            attributes: ['id', 'username', 'avatar']
          }
        ],
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      res.json({
        data: calls.rows,
        pagination: {
          total: calls.count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(calls.count / limit)
        }
      });

    } catch (error) {
      console.error('Get call history error:', error);
      res.status(500).json({ error: 'Failed to fetch call history' });
    }
  }

  // Get active calls for a user
  async getActiveCalls(req, res) {
    try {
      const userId = req.user.id;
      
      const userCallStatus = await redisService.getUserCallStatus(userId);
      if (!userCallStatus) {
        return res.json({ data: null });
      }

      const callData = await redisService.getActiveCall(userCallStatus.callId);
      if (!callData) {
        return res.json({ data: null });
      }

      // Get participant info
      const participants = await User.findAll({
        where: {
          id: callData.participants
        },
        attributes: ['id', 'username', 'avatar']
      });

      res.json({
        data: {
          ...callData,
          participants
        }
      });

    } catch (error) {
      console.error('Get active calls error:', error);
      res.status(500).json({ error: 'Failed to fetch active calls' });
    }
  }

  // Get call statistics
  async getCallStats(req, res) {
    try {
      const userId = req.user.id;
      const { period = '30d' } = req.query;

      let dateFilter = new Date();
      switch (period) {
        case '7d':
          dateFilter.setDate(dateFilter.getDate() - 7);
          break;
        case '30d':
          dateFilter.setDate(dateFilter.getDate() - 30);
          break;
        case '90d':
          dateFilter.setDate(dateFilter.getDate() - 90);
          break;
        default:
          dateFilter.setDate(dateFilter.getDate() - 30);
      }

      const stats = await Call.findAll({
        where: {
          [require('sequelize').Op.or]: [
            { callerId: userId },
            { receiverId: userId }
          ],
          createdAt: {
            [require('sequelize').Op.gte]: dateFilter
          }
        },
        attributes: [
          'status',
          'callType',
          [require('sequelize').fn('COUNT', '*'), 'count'],
          [require('sequelize').fn('SUM', require('sequelize').col('duration')), 'totalDuration']
        ],
        group: ['status', 'callType'],
        raw: true
      });

      const summary = {
        totalCalls: 0,
        totalDuration: 0,
        voiceCalls: 0,
        videoCalls: 0,
        missedCalls: 0,
        answeredCalls: 0
      };

      stats.forEach(stat => {
        summary.totalCalls += parseInt(stat.count);
        summary.totalDuration += parseInt(stat.totalDuration || 0);
        
        if (stat.callType === 'voice') {
          summary.voiceCalls += parseInt(stat.count);
        } else if (stat.callType === 'video') {
          summary.videoCalls += parseInt(stat.count);
        }
        
        if (stat.status === 'missed') {
          summary.missedCalls += parseInt(stat.count);
        } else if (stat.status === 'answered' || stat.status === 'ended') {
          summary.answeredCalls += parseInt(stat.count);
        }
      });

      res.json({ data: summary });

    } catch (error) {
      console.error('Get call stats error:', error);
      res.status(500).json({ error: 'Failed to fetch call statistics' });
    }
  }

  // Delete call from history
  async deleteCall(req, res) {
    try {
      const { callId } = req.params;
      const userId = req.user.id;

      const call = await Call.findOne({
        where: {
          id: callId,
          [require('sequelize').Op.or]: [
            { callerId: userId },
            { receiverId: userId }
          ]
        }
      });

      if (!call) {
        return res.status(404).json({ error: 'Call not found' });
      }

      await call.destroy();
      res.json({ message: 'Call deleted successfully' });

    } catch (error) {
      console.error('Delete call error:', error);
      res.status(500).json({ error: 'Failed to delete call' });
    }
  }
}

module.exports = new CallController();