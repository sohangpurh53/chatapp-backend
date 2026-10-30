const { ChatParticipant } = require('../models');
const { AiError, redact } = require('../services/ai/errors');
const assistant = require('../services/ai/assistant');
const runner = require('../services/ai/runner');
const memory = require('../services/ai/memory');
const actions = require('../services/ai/actions');
const translate = require('../services/ai/translate');
const gameCreator = require('../services/ai/gameCreator');
const privacy = require('../services/ai/privacy');
const { Chat } = require('../models');

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

    if (input.chatId) await requireMembership(input.chatId, req.user.id, { conversation: input.action === 'reply' });

    const { result, target } = await runner.runFeature({
      userId: req.user.id,
      feature: input.feature,
      action: input.action,
      scope: input.action === 'reply' ? 'conversation' : 'drafts',
      signal: controller.signal,
      build: (capabilities, settings) => {
        if (input.action === 'reply') input.context = input.context.slice(-privacy.conversationCap(settings, 'replyMessages'));
        return {
        messages: assistant.buildMessages(input, { json: capabilities.structuredOutput }),
        json: capabilities.structuredOutput,
        // Reasoning models spend part of this on thinking before they answer
        maxTokens: 2048,
        temperature: assistant.temperatureFor(input.action),
        // Editing a chat message doesn't need long thinking; keep it quick
        lowReasoning: true,
        };
      },
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
      return res.status(error.status).json(error.toResponse());
    }
    console.error('[AI] assist failed:', error?.name, redact(error?.message || ''));
    return res.status(500).json({ error: 'The AI assistant failed. Try again.' });
  }
};

const sendFailure = (res, error, fallback) => {
  if (res.headersSent || res.destroyed) return;
  if (error instanceof AiError) {
    res.status(error.status).json(error.toResponse());
    return;
  }
  console.error('[AI] request failed:', error?.name, redact(error?.message || ''));
  res.status(500).json({ error: fallback });
};

/**
 * The caller must be an active member. For conversation content (other
 * people's messages) a group's admins can also have turned AI off.
 */
const requireMembership = async (chatId, userId, { conversation = true } = {}) => {
  const member = await ChatParticipant.findOne({ where: { chatId, userId, isActive: true }, attributes: ['id'] });
  if (!member) throw new AiError('VALIDATION_ERROR', 'You are not a member of this chat.', { status: 403 });
  if (!conversation) return;
  const chat = await Chat.findByPk(chatId, { attributes: ['id', 'isGroup', 'settings'] });
  if (chat?.isGroup && chat.settings?.allowAiOnMessages === false) throw new AiError('GROUP_AI_DISABLED');
};

/** Keep at most as many evidence messages as the user's context level allows (newest last). */
const capEvidence = (input, settings) => {
  const cap = privacy.conversationCap(settings, 'evidence');
  if (input.evidence.length > cap) input.evidence = input.evidence.slice(-cap);
  return input;
};

// POST /ai/memory: answer a question about a chat from evidence the phone
// selected and decrypted. Answers cite the evidence; nothing is stored.
const ask = async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const input = memory.parseRequest(req.body);
    await requireMembership(input.chatId, req.user.id);
    const { result, target } = await runner.runFeature({
      userId: req.user.id,
      feature: 'memory',
      action: input.mode,
      scope: 'conversation',
      signal: controller.signal,
      build: (capabilities, settings) => ({
        messages: memory.buildMessages(capEvidence(input, settings)),
        json: capabilities.structuredOutput,
        maxTokens: 3000,
        temperature: 0.1,
      }),
    });
    if (result.finishReason === 'length' && !result.text.trim()) {
      throw new AiError('BAD_RESPONSE', 'The model ran out of room before answering. Try a shorter time range.');
    }
    res.json({ ...memory.parseAnswer(result.text, input), provider: target, searched: input.evidence.length });
  } catch (error) {
    sendFailure(res, error, 'Group memory failed. Try again.');
  }
};

// POST /ai/actions: proposed action cards from evidence the phone selected.
// Nothing is saved or shared here; the app asks the user about every card.
const findActions = async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const input = actions.parseRequest(req.body);
    await requireMembership(input.chatId, req.user.id);
    const { result, target } = await runner.runFeature({
      userId: req.user.id,
      feature: 'actions',
      action: 'extract',
      scope: 'conversation',
      signal: controller.signal,
      build: (capabilities, settings) => ({
        messages: actions.buildMessages(capEvidence(input, settings)),
        json: capabilities.structuredOutput,
        maxTokens: 3000,
        temperature: 0.1,
      }),
    });
    if (result.finishReason === 'length' && !result.text.trim()) {
      throw new AiError('BAD_RESPONSE', 'The model ran out of room before answering. Try fewer messages.');
    }
    const { cards, checks } = actions.parseCards(result.text, input);
    res.json({ cards, checks, provider: target, searched: input.evidence.length });
  } catch (error) {
    sendFailure(res, error, 'Finding action items failed. Try again.');
  }
};

// POST /ai/games: draft a game from a description, or change a draft. Only
// messages the user ticked are sent. The draft goes back to the phone unsaved.
const createGame = async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const input = gameCreator.parseRequest(req.body);
    if (input.conversation) await requireMembership(input.chatId, req.user.id);
    const { result, target } = await runner.runFeature({
      userId: req.user.id,
      feature: 'games',
      action: input.draft ? 'refine' : 'create',
      // Without chat messages this is only what the user typed
      scope: input.conversation ? 'conversation' : 'drafts',
      signal: controller.signal,
      build: (capabilities, settings) => ({
        messages: gameCreator.buildMessages(input.evidence.length ? capEvidence(input, settings) : input),
        json: capabilities.structuredOutput,
        maxTokens: 6000,
        temperature: 0.7,
        lowReasoning: true,
      }),
    });
    if (result.finishReason === 'length' && !result.text.trim()) {
      throw new AiError('BAD_RESPONSE', 'The model ran out of room before answering. Try fewer rounds.');
    }
    res.json({ ...gameCreator.parseResult(result.text), provider: target });
  } catch (error) {
    sendFailure(res, error, 'Creating the game failed. Try again.');
  }
};

// POST /ai/translate: translate decrypted messages into one language. The app
// keeps the originals and shows translations beside them.
const translateMessages = async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const input = translate.parseRequest(req.body);
    if (input.chatId) await requireMembership(input.chatId, req.user.id);
    const { result, target } = await runner.runFeature({
      userId: req.user.id,
      feature: 'translation',
      action: 'messages',
      // Translating chat messages sends other people's words
      scope: input.chatId ? 'conversation' : 'drafts',
      signal: controller.signal,
      build: (capabilities) => ({
        messages: translate.buildMessages(input),
        json: capabilities.structuredOutput,
        maxTokens: 4000,
        temperature: 0.2,
        lowReasoning: true,
      }),
    });
    res.json({ ...translate.parseTranslations(result.text, input), targetLanguage: input.targetLanguage, provider: target });
  } catch (error) {
    sendFailure(res, error, 'Translation failed. Try again.');
  }
};

/** Tones and languages the assistant accepts (also sent with GET /ai/config). */
const options = () => ({
  tones: Object.keys(assistant.TONES),
  languages: assistant.LANGUAGES,
  maxDraftChars: assistant.LIMITS.textChars,
  maxContextMessages: assistant.LIMITS.contextMessages,
  memory: { maxEvidence: memory.LIMITS.evidenceItems, maxChars: memory.LIMITS.totalChars, maxQuestionChars: memory.LIMITS.questionChars },
});

module.exports = { assist, ask, findActions, translateMessages, createGame, options };
