const { ChatParticipant } = require('../models');
const { AiError, redact } = require('../services/ai/errors');
const assistant = require('../services/ai/assistant');
const runner = require('../services/ai/runner');

// POST /ai/assist: the message assistant. It returns editable drafts and never
// sends anything. Conversation context is decrypted on the user's phone and
// only accepted for a chat the caller is an active member of.

const assist = async (req, res) => {
  // Stop the provider call when the app cancels (closes the connection)
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const input = assistant.parseRequest(req.body);

    if (input.chatId) {
      const member = await ChatParticipant.findOne({
        where: { chatId: input.chatId, userId: req.user.id, isActive: true },
        attributes: ['id'],
      });
      if (!member) throw new AiError('VALIDATION_ERROR', 'You are not a member of this chat.', { status: 403 });
    }

    const { result, target } = await runner.runFeature({
      userId: req.user.id,
      feature: input.feature,
      action: input.action,
      signal: controller.signal,
      build: (capabilities) => ({
        messages: assistant.buildMessages(input, { json: capabilities.structuredOutput }),
        json: capabilities.structuredOutput,
        // Reasoning models spend part of this on thinking before they answer
        maxTokens: 2048,
        temperature: assistant.temperatureFor(input.action),
        // Editing a chat message doesn't need long thinking; keep it quick
        lowReasoning: true,
      }),
    });

    if (result.finishReason === 'length' && !result.text.trim()) {
      throw new AiError('BAD_RESPONSE', 'The model ran out of room before answering. Try a shorter draft or another model.');
    }

    res.json({
      action: input.action,
      drafts: assistant.parseDrafts(result.text, input.count),
      provider: target,
      usage: result.usage,
    });
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    if (error instanceof AiError) {
      return res.status(error.status).json({ error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    }
    console.error('[AI] assist failed:', error?.name, redact(error?.message || ''));
    return res.status(500).json({ error: 'The AI assistant failed. Try again.' });
  }
};

/** Tones and languages the assistant accepts (also sent with GET /ai/config). */
const options = () => ({
  tones: Object.keys(assistant.TONES),
  languages: assistant.LANGUAGES,
  maxDraftChars: assistant.LIMITS.textChars,
  maxContextMessages: assistant.LIMITS.contextMessages,
});

module.exports = { assist, options };
