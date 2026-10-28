const { Op } = require('sequelize');
const { ChatParticipant } = require('../models');

// Optional personal details and who may see each. Default for every field is 'me'.
const PRIVATE_FIELDS = ['firstName', 'middleName', 'lastName', 'bio', 'phone', 'dateOfBirth', 'gender', 'location', 'website'];
const VISIBILITY = ['me', 'contacts', 'everyone'];
const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];

// "Contacts" are people the owner shares an active chat with
const sharesChat = async (userA, userB) => {
  const mine = await ChatParticipant.findAll({ where: { userId: userA, isActive: true }, attributes: ['chatId'], raw: true });
  if (!mine.length) return false;
  const common = await ChatParticipant.findOne({
    where: { userId: userB, isActive: true, chatId: { [Op.in]: mine.map(r => r.chatId) } },
    attributes: ['chatId']
  });
  return !!common;
};

const normalizePrivacy = (stored) => {
  const out = {};
  for (const f of PRIVATE_FIELDS) {
    out[f] = VISIBILITY.includes(stored?.[f]) ? stored[f] : 'me';
  }
  return out;
};

// The details `viewerId` may see on `owner`'s profile; the server decides, so a hidden
// field never reaches the viewer's phone.
const visibleDetails = async (owner, viewerId) => {
  const privacy = normalizePrivacy(owner.profilePrivacy);
  const isContact = owner.id === viewerId ? true : await sharesChat(owner.id, viewerId);
  const details = {};
  for (const f of PRIVATE_FIELDS) {
    const value = owner[f];
    if (value === null || value === undefined || value === '') continue;
    const level = privacy[f];
    if (owner.id === viewerId || level === 'everyone' || (level === 'contacts' && isContact)) {
      details[f] = value;
    }
  }
  return details;
};

// Validates the optional-details part of a profile update. Returns { data } with
// values to store (null clears a field) or { error }.
const parseDetailsUpdate = (body) => {
  const data = {};
  const text = (key, max) => {
    if (body[key] === undefined) return null;
    const v = body[key] === null ? '' : String(body[key]).trim();
    if (v.length > max) return `${key} must be at most ${max} characters`;
    data[key] = v || null;
    return null;
  };
  const errors = [
    text('firstName', 50),
    text('middleName', 50),
    text('lastName', 50),
    text('bio', 300),
    text('location', 100),
    text('website', 200),
  ].filter(Boolean);
  if (errors.length) return { error: errors[0] };

  if (data.website && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(data.website)) {
    return { error: 'Website must start with http:// or https://' };
  }

  if (body.phone !== undefined) {
    const v = body.phone === null ? '' : String(body.phone).trim();
    if (v && !/^\+?[0-9 ()-]{6,20}$/.test(v)) return { error: 'Please enter a valid phone number' };
    data.phone = v || null;
  }

  if (body.gender !== undefined) {
    const v = body.gender === null ? '' : String(body.gender).trim();
    if (v && !GENDERS.includes(v)) return { error: 'Invalid gender value' };
    data.gender = v || null;
  }

  if (body.dateOfBirth !== undefined) {
    const v = body.dateOfBirth === null ? '' : String(body.dateOfBirth).trim();
    if (v) {
      const d = new Date(`${v}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
        return { error: 'Date of birth must be a valid date (YYYY-MM-DD)' };
      }
      if (d.getTime() > Date.now() || d.getUTCFullYear() < 1900) {
        return { error: 'Date of birth is not valid' };
      }
    }
    data.dateOfBirth = v || null;
  }

  if (body.profilePrivacy !== undefined) {
    const incoming = body.profilePrivacy;
    if (!incoming || typeof incoming !== 'object') return { error: 'Invalid privacy settings' };
    const cleaned = {};
    for (const [field, level] of Object.entries(incoming)) {
      if (!PRIVATE_FIELDS.includes(field) || !VISIBILITY.includes(level)) {
        return { error: 'Invalid privacy settings' };
      }
      cleaned[field] = level;
    }
    data.profilePrivacyPatch = cleaned;
  }

  return { data };
};

module.exports = { PRIVATE_FIELDS, VISIBILITY, GENDERS, normalizePrivacy, visibleDetails, parseDetailsUpdate, sharesChat };
