// Room left for the rest of the push data (names, ids, avatar URL) under FCM's 4 KB
const MAX_PUSH_CIPHERTEXT = 2800;

/** { encryptedPayload, createdAt } for a short encrypted text message, else nothing. */
const encryptedPushPayload = (isEncrypted, messageType, encryptedContent, createdAt) => {
  if (!isEncrypted || (messageType && messageType !== 'text') || !encryptedContent) return {};
  const payload = typeof encryptedContent === 'string' ? encryptedContent : JSON.stringify(encryptedContent);
  if (payload.length > MAX_PUSH_CIPHERTEXT) return {};
  return {
    encryptedPayload: payload,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt || '')
  };
};

module.exports = { encryptedPushPayload, MAX_PUSH_CIPHERTEXT };
