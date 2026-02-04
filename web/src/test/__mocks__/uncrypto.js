/* eslint-disable @typescript-eslint/unbound-method */
// Mock for uncrypto module (ESM module that Jest can't parse)
// This provides stub implementations for testing

const getRandomValues = (arr) => {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = Math.floor(Math.random() * 256);
  }
  return arr;
};

const randomUUID = () => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

const subtle = {
  digest: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
  encrypt: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
  decrypt: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
  sign: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
  verify: jest.fn().mockResolvedValue(true),
  generateKey: jest.fn().mockResolvedValue({}),
  importKey: jest.fn().mockResolvedValue({}),
  exportKey: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
  deriveBits: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
  deriveKey: jest.fn().mockResolvedValue({}),
  wrapKey: jest.fn().mockResolvedValue(new ArrayBuffer(32)),
  unwrapKey: jest.fn().mockResolvedValue({}),
};

const crypto = { getRandomValues, randomUUID, subtle };

module.exports = crypto;
module.exports.default = crypto;
module.exports.getRandomValues = getRandomValues;
module.exports.randomUUID = randomUUID;
module.exports.subtle = subtle;
