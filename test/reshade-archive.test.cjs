'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pe } = require('./helpers.cjs');
const { sha256 } = require('../src/core/safety.cjs');
const { writeZip, readZip } = require('../src/core/packages.cjs');
const { unpackOfficial } = require('../src/core/reshade.cjs');
function fixture(trailerLength) {
  const dll = pe(1); dll.write('Searching for add-ons', 600, 'ascii');
  const zip = writeZip([['ReShade64.dll', dll], ['ReShade64.json', Buffer.from('{}')]]);
  const bytes = Buffer.concat([pe(2, false), zip, Buffer.alloc(trailerLength, 0x5a)]);
  const pin = { size: bytes.length, sha256: sha256(bytes), dll: { name: 'ReShade64.dll', size: dll.length, sha256: sha256(dll) } };
  return { dll, zip, bytes, pin };
}
test('fixed official setup can have a bounded signing trailer after its ZIP without relaxing user package parsing', () => {
  const { dll, zip, bytes, pin } = fixture(8192);
  assert.deepEqual(unpackOfficial(bytes, pin), dll);
  assert.throws(() => readZip(Buffer.concat([zip, Buffer.alloc(8192)])), e => e.code === 'ZIP_INVALID');
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  assert.throws(() => unpackOfficial(changed, pin), e => e.code === 'RESHADE_CHECKSUM');
});
test('official archive still rejects unbounded trailing data and incorrect payload hash', () => {
  const tooLong = fixture(65537);
  assert.throws(() => unpackOfficial(tooLong.bytes, tooLong.pin), e => e.code === 'RESHADE_ARCHIVE');
  const f = fixture(1024); f.pin.dll.sha256 = '0'.repeat(64);
  assert.throws(() => unpackOfficial(f.bytes, f.pin), e => e.code === 'RESHADE_CAPABILITY');
});
