const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { UserBlock, ChatParticipant } = require('../models');
const { isBlockedEitherWay, directPeerId } = require('../utils/blocks');
const { parseDetailsUpdate, visibleDetails, normalizePrivacy } = require('../utils/profilePrivacy');

describe('blocking', () => {
  const original = UserBlock.findOne;
  afterEach(() => { UserBlock.findOne = original; });

  test('is symmetric: the query matches either direction', async () => {
    let where;
    UserBlock.findOne = async (q) => { where = q.where; return { id: 'b1' }; };

    assert.equal(await isBlockedEitherWay('a', 'b'), true);
    const pairs = Object.getOwnPropertySymbols(where).flatMap(s => where[s]);
    assert.deepEqual(pairs, [
      { blockerId: 'a', blockedId: 'b' },
      { blockerId: 'b', blockedId: 'a' },
    ]);
  });

  test('no block row means not blocked', async () => {
    UserBlock.findOne = async () => null;
    assert.equal(await isBlockedEitherWay('a', 'b'), false);
  });

  test('directPeerId only resolves for 1:1 chats', () => {
    const direct = { isGroup: false, participant1Id: 'a', participant2Id: 'b' };
    assert.equal(directPeerId(direct, 'a'), 'b');
    assert.equal(directPeerId(direct, 'b'), 'a');
    assert.equal(directPeerId(direct, 'c'), null);
    assert.equal(directPeerId({ ...direct, isGroup: true }, 'a'), null);
  });
});

describe('Google names', () => {
  const { splitGoogleNames } = require('../controllers/authController');

  test('given name words after the first become the middle name', () => {
    assert.deepEqual(splitGoogleNames({ given_name: 'Anna Maria', family_name: 'Smith' }),
      { firstName: 'Anna', middleName: 'Maria', lastName: 'Smith' });
  });

  test('a single given name has no middle name', () => {
    assert.deepEqual(splitGoogleNames({ given_name: 'Anna', family_name: 'Smith' }),
      { firstName: 'Anna', middleName: null, lastName: 'Smith' });
  });

  test('falls back to the display name when Google sends no parts', () => {
    assert.deepEqual(splitGoogleNames({ name: 'Anna Maria Smith' }),
      { firstName: 'Anna', middleName: 'Maria', lastName: 'Smith' });
    assert.deepEqual(splitGoogleNames({ name: 'Madonna' }),
      { firstName: 'Madonna', middleName: null, lastName: null });
  });

  test('no name at all is fine', () => {
    assert.deepEqual(splitGoogleNames({}), { firstName: null, middleName: null, lastName: null });
  });
});

describe('optional personal details', () => {
  test('every field is optional: an empty update is valid', () => {
    assert.deepEqual(parseDetailsUpdate({}).data, {});
  });

  test('empty strings clear a field', () => {
    assert.deepEqual(parseDetailsUpdate({ bio: '  ', phone: '', dateOfBirth: '' }).data,
      { bio: null, phone: null, dateOfBirth: null });
  });

  test('rejects bad values only when provided', () => {
    assert.match(parseDetailsUpdate({ phone: 'abc' }).error, /phone/i);
    assert.match(parseDetailsUpdate({ dateOfBirth: '2999-01-01' }).error, /not valid/i);
    assert.match(parseDetailsUpdate({ dateOfBirth: '2020-02-31' }).error, /valid date/i);
    assert.match(parseDetailsUpdate({ gender: 'x' }).error, /gender/i);
    assert.match(parseDetailsUpdate({ website: 'example.com' }).error, /http/i);
    assert.match(parseDetailsUpdate({ profilePrivacy: { bio: 'nobody' } }).error, /privacy/i);
  });

  test('accepts good values', () => {
    const { data } = parseDetailsUpdate({
      bio: 'hi', phone: '+91 98765 43210', dateOfBirth: '1995-05-20', gender: 'female',
      website: 'https://example.com', profilePrivacy: { bio: 'everyone' },
    });
    assert.equal(data.dateOfBirth, '1995-05-20');
    assert.deepEqual(data.profilePrivacyPatch, { bio: 'everyone' });
  });

  describe('visibility', () => {
    const original = { findAll: ChatParticipant.findAll, findOne: ChatParticipant.findOne };
    afterEach(() => { Object.assign(ChatParticipant, { findAll: original.findAll, findOne: original.findOne }); });

    const owner = {
      id: 'owner', bio: 'hello', phone: '+911234567', location: 'Pune', gender: null,
      profilePrivacy: { bio: 'everyone', phone: 'contacts' },
    };
    const share = (yes) => {
      ChatParticipant.findAll = async () => [{ chatId: 'c1' }];
      ChatParticipant.findOne = async () => (yes ? { chatId: 'c1' } : null);
    };

    test('defaults to private: unspecified fields are only for the owner', () => {
      assert.equal(normalizePrivacy(undefined).bio, 'me');
    });

    test('a stranger sees only "everyone" fields', async () => {
      share(false);
      assert.deepEqual(await visibleDetails(owner, 'stranger'), { bio: 'hello' });
    });

    test('a contact also sees "contacts" fields, never "me" ones', async () => {
      share(true);
      assert.deepEqual(await visibleDetails(owner, 'friend'), { bio: 'hello', phone: '+911234567' });
    });

    test('the owner sees everything they filled in', async () => {
      assert.deepEqual(await visibleDetails(owner, 'owner'), { bio: 'hello', phone: '+911234567', location: 'Pune' });
    });
  });
});
