// Build a SYNTHETIC Firefox profile (key4.db + logins.json) with known passwords, in exactly the
// on-disk format this app must read. Used by `npm run smoke:creds`; no owner data is involved and
// every secret here is a published test constant.
//
// Deterministic: only the login-field IVs are random, and nothing asserts on them.
// Usage: node scripts/firefox-fixture.js <outDir> [--master-password <pw>] [--legacy]
//   default (modern): PBES2 / PBKDF2-HMAC-SHA256 / AES-256-CBC key4, AES-256-CBC login fields
//   --legacy:         PBES1 PBE-SHA1-3DES key4, 3DES login fields — proves the REFUSAL path
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- minimal DER encoder (SEQ / INT / OCTET STRING / OID) ----------
function tlv(tag, content) {
  const len = content.length;
  let header;
  if (len < 0x80) header = Buffer.from([tag, len]);
  else if (len < 0x100) header = Buffer.from([tag, 0x81, len]);
  else header = Buffer.from([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([header, content]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const octet = b => tlv(0x04, b);
function int(n) {
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  if (!bytes.length) bytes.push(0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
const oidHex = hex => tlv(0x06, Buffer.from(hex, 'hex'));

const OID = {
  pbes2: '2a864886f70d01050d',
  pbkdf2: '2a864886f70d01050c',
  prfSha256: '2a864886f70d0209',
  aes256: '60864801650304012a',
  des3: '2a864886f70d0307',
  pbeSha1Des3: '2a864886f70d010c0103', // 1.2.840.113549.1.12.1.3 — the pre-63 generation
};
const CKA_ID_SDR = Buffer.from('f8000000000000000000000000000001', 'hex');

function pkcs7Pad(buf, block) {
  const pad = block - (buf.length % block);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}
const sha1 = b => crypto.createHash('sha1').update(b).digest();

// The modern PBES2 blob: SHA1(globalSalt||pw) as the PBKDF2 password, 14-byte stored IV rebuilt
// as `04 0e || iv`. The check plaintext is the 14-byte 'password-check' plus PKCS#7 padding — a
// fixture that encrypts a padded 16-byte literal produces the wrong check value and must fail.
function pbes2Encrypt(plaintextBuf, passwordBuf, globalSalt, { salt, iv14, iterations = 1, keyLen = 32 } = {}) {
  const pwHash = sha1(Buffer.concat([globalSalt, passwordBuf]));
  const key = crypto.pbkdf2Sync(pwHash, salt, iterations, keyLen, 'sha256');
  const iv = Buffer.concat([Buffer.from([0x04, 0x0e]), iv14]);
  if (iv.length !== 16) throw new Error('bad iv');
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(pkcs7Pad(plaintextBuf, 16)), c.final()]);
  const algid = seq(
    oidHex(OID.pbes2),
    seq(
      seq(oidHex(OID.pbkdf2), seq(octet(salt), int(iterations), int(keyLen), seq(oidHex(OID.prfSha256)))),
      seq(oidHex(OID.aes256), octet(iv14)),
    ),
  );
  return seq(algid, octet(ct));
}

// The old (Firefox <=62) generation: PBE-SHA1-3DES. Only ever produced to prove the refusal.
function pbes1Encrypt(plaintextBuf, passwordBuf, globalSalt, { salt } = {}) {
  const base = sha1(Buffer.concat([globalSalt, passwordBuf]));
  const k1 = sha1(Buffer.concat([base, salt]));
  const key = Buffer.concat([k1, sha1(Buffer.concat([k1, base, salt]))]).subarray(0, 24);
  const iv = sha1(Buffer.concat([key, base, salt])).subarray(0, 8);
  const c = crypto.createCipheriv('des-ede3-cbc', key, iv);
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(pkcs7Pad(plaintextBuf, 8)), c.final()]);
  return seq(seq(oidHex(OID.pbeSha1Des3), seq(octet(salt), int(1))), octet(ct));
}

function encryptLoginField(plaintextStr, sdrKey, { modern = true } = {}) {
  const ctBuf = Buffer.from(plaintextStr, 'utf8');
  if (modern) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', sdrKey.subarray(0, 32), iv);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(pkcs7Pad(ctBuf, 16)), c.final()]);
    return seq(octet(CKA_ID_SDR), seq(oidHex(OID.aes256), octet(iv)), octet(ct)).toString('base64');
  }
  const iv = crypto.randomBytes(8);
  const c = crypto.createCipheriv('des-ede3-cbc', sdrKey.subarray(0, 24), iv);
  c.setAutoPadding(false);
  const ct = Buffer.concat([c.update(pkcs7Pad(ctBuf, 8)), c.final()]);
  return seq(octet(CKA_ID_SDR), seq(oidHex(OID.des3), octet(iv)), octet(ct)).toString('base64');
}

// The known, published contents. Every password is invented for the test.
//   KNOWN_WEB      — importable rows (one per host family)
//   KNOWN_NON_WEB  — a saved login whose origin is not a web origin: skipped and counted
//   KNOWN_BLANK    — a saved login with no username: skipped (mergeCredentials drops it anyway)
const KNOWN_WEB = [
  { hostname: 'https://example.test', username: 'alice@example.test', password: 'S3cret-Alpha!' },
  { hostname: 'https://accounts.example.org', username: 'bob', password: 'correct horse battery staple' },
  { hostname: 'https://login.example.net/submit', username: 'carol', password: 'p@ss"word,with,commas' },
  { hostname: 'https://unicode.example.test', username: 'üser@example.test', password: 'パスワード–✓' },
];
const KNOWN_NON_WEB = [
  { hostname: 'chrome://settings', username: 'browser-internal', password: 'not-a-web-login' },
];
const KNOWN_BLANK = [
  { hostname: 'http://blank-user.example.test', username: '', password: 'only-password' },
];

function build(outDir, { masterPassword = '', modern = true, passwordOverrides = null } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const key4Path = path.join(outDir, 'key4.db');
  try { fs.rmSync(key4Path, { force: true }); } catch {}
  const db = new DatabaseSync(key4Path);
  db.exec(fs.readFileSync(path.join(__dirname, 'key4-schema.sql'), 'utf8'));

  const globalSalt = Buffer.from('00112233445566778899aabbccddeeff00112233', 'hex'); // fixed, not secret
  const pw = Buffer.from(masterPassword, 'utf8');

  const item2 = modern
    ? pbes2Encrypt(Buffer.from('password-check', 'binary'), pw, globalSalt, { salt: Buffer.from('a'.repeat(32)), iv14: Buffer.from('b'.repeat(14)) })
    : pbes1Encrypt(Buffer.from('password-check', 'binary'), pw, globalSalt, { salt: Buffer.from('c'.repeat(20)) });
  db.prepare('INSERT INTO metaData (id, item1, item2) VALUES (?,?,?)').run('password', globalSalt, item2);

  const sdrRaw = modern
    ? Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex') // 32 B → AES-256
    : Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');                 // 24 B → 3DES
  const a11 = modern
    ? pbes2Encrypt(sdrRaw, pw, globalSalt, { salt: Buffer.from('d'.repeat(32)), iv14: Buffer.from('e'.repeat(14)) })
    : pbes1Encrypt(sdrRaw, pw, globalSalt, { salt: Buffer.from('f'.repeat(20)) });
  const insertKey = db.prepare('INSERT INTO nssPrivate (id, a0, a1, a2, a3, a11, a102, a110, a111) VALUES (?,?,?,?,?,?,?,?,?)');
  if (modern) {
    // A STALE rekeyed generation, exactly as the real profile has it: a 24-byte (3DES-era) key under
    // the SAME CKA_ID, inserted FIRST. A reader that takes the first CKA_ID match imports nothing
    // usable; only trial-decrypting against the saved logins finds the real key below.
    const staleKey = Buffer.from('fedcba9876543210fedcba9876543210fedcba9876543210', 'hex');
    const staleA11 = pbes2Encrypt(staleKey, pw, globalSalt, { salt: Buffer.from('9'.repeat(32)), iv14: Buffer.from('8'.repeat(14)) });
    insertKey.run(1, Buffer.from([0, 0]), Buffer.from([1]), Buffer.from([1]), Buffer.from([0xa5, 0x00, 0x00]), staleA11, CKA_ID_SDR, Buffer.from([0xa5, 0x00, 0x00]), Buffer.from([0xa5, 0x00, 0x00]));
  }
  insertKey.run(modern ? 2 : 1, Buffer.from([0, 0]), Buffer.from([1]), Buffer.from([1]), Buffer.from([0xa5, 0x00, 0x00]), a11, CKA_ID_SDR, Buffer.from([0xa5, 0x00, 0x00]), Buffer.from([0xa5, 0x00, 0x00]));
  db.close();

  // passwordOverrides lets a caller rebuild the SAME profile with one changed password, which is how
  // the in-place-merge check proves the frozen merge contract rather than a fresh import.
  const entries = [...KNOWN_WEB, ...KNOWN_NON_WEB, ...KNOWN_BLANK].map(e => (
    passwordOverrides && passwordOverrides[e.username] != null
      ? { ...e, password: passwordOverrides[e.username] }
      : e
  ));
  const logins = entries.map((e, i) => ({
    id: i + 1,
    hostname: e.hostname,
    httpRealm: null,
    formSubmitURL: e.hostname,
    usernameField: 'user',
    passwordField: 'pass',
    encryptedUsername: encryptLoginField(e.username, sdrRaw, { modern }),
    encryptedPassword: encryptLoginField(e.password, sdrRaw, { modern }),
    guid: `{guid-${i}}`,
    encType: 1,
    timeCreated: 1700000000000 + i,
    timeLastUsed: 1700000000000 + i,
    timePasswordChanged: 1700000000000 + i,
    timesUsed: 1,
    syncCounter: 0,
    everSynced: false,
    encryptedUnknownFields: '',
  }));
  fs.writeFileSync(path.join(outDir, 'logins.json'), JSON.stringify({ nextId: entries.length + 1, logins, potentiallyVulnerablePasswords: [], version: 3, sync: {} }));
  return { outDir, key4Path, loginsPath: path.join(outDir, 'logins.json'), entries, modern, masterPassword };
}

module.exports = { build, KNOWN_WEB, KNOWN_NON_WEB, KNOWN_BLANK, CKA_ID_SDR, pbes2Encrypt };

if (require.main === module) {
  const outDir = process.argv[2];
  if (!outDir) { console.error('usage: node scripts/firefox-fixture.js <outDir> [--master-password pw] [--legacy]'); process.exit(2); }
  const pi = process.argv.indexOf('--master-password');
  const masterPassword = pi > -1 ? process.argv[pi + 1] : '';
  const r = build(outDir, { masterPassword, modern: !process.argv.includes('--legacy') });
  console.log(JSON.stringify({ ok: true, outDir: r.outDir, modern: r.modern, masterPasswordSet: !!masterPassword, entries: r.entries.length }, null, 2));
}
