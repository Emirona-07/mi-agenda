'use strict';

const crypto = require('crypto');

const HASH_PREFIX = 'pbkdf2_sha256';
const ITERATIONS = 210000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `${HASH_PREFIX}$${ITERATIONS}$${salt}$${hash}`;
}

function isPasswordHash(value) {
  return typeof value === 'string' && value.startsWith(`${HASH_PREFIX}$`);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyPassword(password, stored) {
  if (!stored) return false;

  if (!isPasswordHash(stored)) {
    return safeEqual(password, stored);
  }

  const [, iterations, salt, expected] = stored.split('$');
  if (!iterations || !salt || !expected) return false;

  const actual = crypto
    .pbkdf2Sync(String(password), salt, parseInt(iterations, 10), Buffer.from(expected, 'hex').length, DIGEST)
    .toString('hex');

  return safeEqual(actual, expected);
}

module.exports = {
  hashPassword,
  isPasswordHash,
  verifyPassword,
};
