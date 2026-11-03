// Direct password import from a Firefox profile (key4.db + logins.json).
//
// Pure Node: built-in crypto only, and the same `node:sqlite` driver the Chromium importer already
// uses — no new dependency and no native addon, so the installer's scope does not change.
//
// Format facts (proven by the investigation, `.orchestration/specs/INVESTIGATION-FIREFOX-IMPORT.md`;
// every one of them was measured against a real profile copy and a hermetic synthetic fixture):
//   profiles.ini is UTF-16LE WITH A BOM. Read it as UTF-8 and you get NUL-interleaved garbage.
//   key4.db metaData(id='password'): item1 = 20-byte raw global salt;
//     item2 = DER SEQ { SEQ { OID pbes2, SEQ { SEQ{OID pbkdf2, SEQ{salt, iter, keyLen, SEQ{OID sha256}}},
//                                       SEQ{OID aes256CBC, OCTET iv14} } }, OCTET ciphertext }
//     The PBKDF2 *password input* is SHA1(globalSalt || masterPassword) — not the password itself.
//     The stored IV is 14 bytes and Firefox rebuilds the 16-byte AES IV as `04 0e || iv14`
//     (the DER OCTET STRING header it was stripped from). Zero-padding it produces garbage.
//     The decrypted plaintext is the literal 'password-check' + PKCS#7 pad; comparing it is the
//     only way to know a master password is set, and it is checked before anything is imported.
//   key4.db nssPrivate: several rows can share CKA_ID f8…01 (rekeyed generations). The plaintext
//     key material is 32 bytes (stale 3DES generation, 24 useful) or 48 bytes (AES-256, 32 useful).
//     Only ONE of them decrypts the current logins.json, so the right row is chosen BY TRIAL —
//     taking the first match imports zero usable logins.
//   logins.json encryptedUsername/encryptedPassword = base64 of
//     DER SEQ { OCTET keyId16, SEQ { OID cipher, OCTET iv16 }, OCTET ciphertext }, PKCS#7 padded.
//
// Everything here is read-only against the profile directory. No plaintext is ever written to disk
// and no field is ever logged.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const OID_PBES2 = '2a864886f70d01050d';       // 1.2.840.113549.1.5.13
const OID_PBKDF2 = '2a864886f70d01050c';      // 1.2.840.113549.1.5.12
const OID_PRF_SHA1 = '2a864886f70d0207';      // 1.2.840.113549.2.7
const OID_PRF_SHA256 = '2a864886f70d0209';    // 1.2.840.113549.2.9
const OID_DES3 = '2a864886f70d0307';          // 1.2.840.113549.3.7
const OID_AES256 = '60864801650304012a';      // 2.16.840.1.101.3.4.1.42
const OID_AES128 = '608648016503040102';      // 2.16.840.1.101.3.4.1.2
const OID_PBE_SHA1_3DES = '2a864886f70d010c0103'; // 1.2.840.113549.1.12.1.3 — pre-63 legacy
const CKA_ID_SDR = Buffer.from('f8000000000000000000000000000001', 'hex');
const PASSWORD_CHECK = Buffer.from('password-check\x02\x02', 'binary');

// A named failure so callers can distinguish refusals from crashes. The message is what the user
// sees: it must say what is wrong and what to do instead, never something vague.
class FirefoxImportError extends Error {
  constructor(message, code) { super(message); this.name = 'FirefoxImportError'; this.code = code; }
}

// ---------- minimal DER reader (SEQ / INTEGER / OCTET STRING / OID — all this format uses) ----------
function readLen(buf, i) {
  const b = buf[i++];
  if (b < 0x80) return { len: b, i };
  const n = b & 0x7f;
  if (n === 0 || n > 4) throw new Error('unsupported DER length');
  let len = 0;
  for (let k = 0; k < n; k++) len = len * 256 + buf[i++];
  return { len, i };
}
function parseNode(buf) {
  if (buf.length < 2) throw new Error('truncated DER');
  const tag = buf[0];
  const r = readLen(buf, 1);
  const end = r.i + r.len;
  if (end > buf.length) throw new Error('DER length past end');
  return { tag, value: buf.subarray(r.i, end), rest: buf.subarray(end) };
}
function childrenOf(valueBuf) {
  const out = [];
  let p = valueBuf;
  while (p.length) { const c = parseNode(p); out.push(c); p = c.rest; }
  return out;
}
function seqChildren(node) {
  if (!node || node.tag !== 0x30) throw new Error('expected SEQUENCE');
  return childrenOf(node.value);
}
function parseSeq(buf) { return seqChildren(parseNode(buf)); }
function intOf(n) {
  if (n.tag !== 0x02) throw new Error('expected INTEGER');
  let v = 0;
  for (const b of n.value) v = v * 256 + b;
  return v;
}
function oidOf(n) {
  if (n.tag !== 0x06) throw new Error('expected OID');
  return n.value.toString('hex');
}

function cipherFor(oid) {
  if (oid === OID_AES256) return { alg: 'aes-256-cbc', keyBytes: 32, block: 16 };
  if (oid === OID_AES128) return { alg: 'aes-128-cbc', keyBytes: 16, block: 16 };
  if (oid === OID_DES3) return { alg: 'des-ede3-cbc', keyBytes: 24, block: 8 };
  return null;
}

function unpad(buf, block) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > block || pad > buf.length) throw new Error('bad PKCS#7 padding');
  for (let k = 0; k < pad; k++) if (buf[buf.length - 1 - k] !== pad) throw new Error('bad PKCS#7 padding');
  return buf.subarray(0, buf.length - pad);
}

// Decrypt a PBES2 AlgorithmIdentifier + ciphertext blob. Returns the still-padded plaintext.
function pbes2Decrypt(derBytes, passwordBuf, globalSalt) {
  let seq;
  try { seq = parseSeq(derBytes); } catch (err) { throw new Error('not PBES2 (' + err.message + ')'); }
  const algInner = seqChildren(seq[0]);
  const algOid = oidOf(algInner[0]);
  if (algOid !== OID_PBES2) {
    // Distinguish the old generation so the caller can refuse it with the right words.
    if (algOid === OID_PBE_SHA1_3DES) throw new FirefoxImportError(
      'This Firefox profile uses the old Firefox format (Firefox 62 and earlier) — export the passwords to CSV from Firefox instead.',
      'FIREFOX_LEGACY_FORMAT');
    throw new FirefoxImportError(
      'This Firefox profile uses a key format this app does not understand — export the passwords to CSV from Firefox instead.',
      'FIREFOX_UNSUPPORTED_FORMAT');
  }
  const params = seqChildren(algInner[1]);
  const kdf = seqChildren(params[0]);
  if (oidOf(kdf[0]) !== OID_PBKDF2) throw new Error('not PBKDF2');
  const kdfParams = seqChildren(kdf[1]);
  const salt = kdfParams[0].value;
  const iter = intOf(kdfParams[1]);
  const keyLen = kdfParams[2] ? intOf(kdfParams[2]) : 32;
  let prf = 'sha256';
  if (kdfParams[3]) {
    const p = oidOf(seqChildren(kdfParams[3])[0]);
    if (p === OID_PRF_SHA1) prf = 'sha1';
    else if (p === OID_PRF_SHA256) prf = 'sha256';
    else throw new Error('unsupported PBKDF2 PRF ' + p);
  }
  const enc = seqChildren(params[1]);
  const cipher = cipherFor(oidOf(enc[0]));
  if (!cipher) throw new Error('unsupported cipher ' + oidOf(enc[0]));
  const storedIv = enc[1].value;
  const ciphertext = seq[1].value;

  // Firefox stores 14 bytes and rebuilds 16 as `04 0e || iv`. Never zero-pad: the trap here is that
  // a zero-padded IV still produces a well-formed 16-byte block and fails only as bad padding or a
  // wrong `password-check`, which reads like a master password.
  if (storedIv.length !== 14) throw new Error(`unsupported stored IV length ${storedIv.length} (expected 14)`);
  const iv = Buffer.concat([Buffer.from([0x04, 0x0e]), storedIv]);

  const pwHash = crypto.createHash('sha1').update(Buffer.concat([globalSalt, passwordBuf])).digest();
  const key = crypto.pbkdf2Sync(pwHash, salt, iter, keyLen, prf);
  const d = crypto.createDecipheriv(cipher.alg, key.subarray(0, cipher.keyBytes), iv);
  d.setAutoPadding(false);
  return { plaintext: Buffer.concat([d.update(ciphertext), d.final()]), cipher };
}

// Decrypt one logins.json field with one candidate SDR key.
function decodeLoginField(b64, sdr) {
  const der = Buffer.from(String(b64 || ''), 'base64');
  const seq = parseSeq(der);
  const alg = seqChildren(seq[1]);
  const cipher = cipherFor(oidOf(alg[0]));
  if (!cipher) throw new Error('unsupported login cipher');
  const iv = alg[1].value;
  const ct = seq[2].value;
  const d = crypto.createDecipheriv(cipher.alg, sdr.key.subarray(0, cipher.keyBytes), iv);
  d.setAutoPadding(false);
  return unpad(Buffer.concat([d.update(ct), d.final()]), cipher.block).toString('utf8');
}

// Every SDR candidate in key4.db, in the order the database returns them, each fully decrypted.
function sdrCandidates(key4Path, passwordBuf) {
  let db;
  try { db = new DatabaseSync(key4Path, { readOnly: true }); }
  catch (err) {
    throw new FirefoxImportError('This Firefox key database could not be read (' + err.message + ') — export the passwords to CSV from Firefox instead.', 'FIREFOX_CORRUPT');
  }
  try {
    let meta;
    try { meta = db.prepare("SELECT item1, item2 FROM metaData WHERE id = 'password'").get(); }
    catch (err) { throw new FirefoxImportError('This Firefox key database could not be read (' + err.message + ') — export the passwords to CSV from Firefox instead.', 'FIREFOX_CORRUPT'); }
    if (!meta || !meta.item1 || !meta.item2) throw new FirefoxImportError(
      'This Firefox key database has no password record — export the passwords to CSV from Firefox instead.', 'FIREFOX_CORRUPT');
    const globalSalt = Buffer.from(meta.item1);

    let check;
    try { check = pbes2Decrypt(Buffer.from(meta.item2), passwordBuf, globalSalt); }
    catch (err) { if (err instanceof FirefoxImportError) throw err; throw new FirefoxImportError(
      'This Firefox profile has a master password set (or its key database is damaged) — export the passwords to CSV from Firefox instead.',
      'FIREFOX_MASTER_PASSWORD'); }
    if (!check.plaintext.equals(PASSWORD_CHECK)) {
      // Only a wrong password input produces a well-formed but wrong plaintext; a damaged ciphertext
      // usually fails padding instead. Both are the same honest "master password or damage" refusal.
      throw new FirefoxImportError(
        'This Firefox profile has a master password set (or its key database is damaged) — export the passwords to CSV from Firefox instead.',
        'FIREFOX_MASTER_PASSWORD');
    }

    let rows;
    try { rows = db.prepare('SELECT a11, a102 FROM nssPrivate').all(); }
    catch (err) { throw new FirefoxImportError('This Firefox key database has no key table (' + err.message + ') — export the passwords to CSV from Firefox instead.', 'FIREFOX_CORRUPT'); }
    const out = [];
    for (const row of rows) {
      if (!row.a102 || !Buffer.from(row.a102).equals(CKA_ID_SDR)) continue;
      let raw;
      try { raw = pbes2Decrypt(Buffer.from(row.a11), passwordBuf, globalSalt).plaintext; }
      catch (err) { if (err instanceof FirefoxImportError) throw err; continue; }
      // 48 bytes = AES-256 key (32 + 16 pad); 32 bytes = the stale 3DES generation (24 + 8 pad).
      if (raw.length === 48) out.push({ key: raw.subarray(0, 32), cipher: 'aes-256-cbc', block: 16 });
      else if (raw.length === 32) out.push({ key: raw.subarray(0, 24), cipher: 'des-ede3-cbc', block: 8 });
    }
    if (!out.length) throw new FirefoxImportError(
      'This Firefox profile has no usable saved-login key — export the passwords to CSV from Firefox instead.', 'FIREFOX_CORRUPT');
    return out;
  } finally {
    try { db.close(); } catch {}
  }
}

// Pick the candidate that actually decrypts this profile's saved logins. Taking the first CKA_ID
// match instead would import an entire profile of failures (the stale 3DES row sorts first).
function pickSdr(candidates, entries) {
  const probes = entries.filter(e => e && e.encryptedUsername && e.encryptedPassword).slice(0, 3);
  for (const cand of candidates) {
    let decrypted = 0;
    let ok = 0;
    for (const e of probes) {
      try {
        const u = decodeLoginField(e.encryptedUsername, cand);
        const p = decodeLoginField(e.encryptedPassword, cand);
        // Valid padding is not proof; control characters in a decrypted login field are proof of a
        // wrong key. Require every probe to decode cleanly.
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(u) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p)) break;
        if (u) decrypted++;
        ok++;
      } catch { break; }
    }
    if (probes.length && ok === probes.length && decrypted > 0) return cand;
  }
  if (!probes.length) {
    // Nothing to trial against (an empty logins.json). Prefer AES-256, but nothing will decrypt.
    return candidates.find(c => c.cipher === 'aes-256-cbc') || candidates[0];
  }
  throw new FirefoxImportError(
    'This Firefox profile\'s saved logins could not be decrypted — its key database may be damaged. Export the passwords to CSV from Firefox instead.',
    'FIREFOX_CORRUPT');
}

function firefoxRoot() {
  // MAM_FIREFOX_ROOT exists so the test suite and demo screenshots can point the profile LIST at a
  // synthetic root. It never changes how a profile is decrypted — that always uses the folder the
  // user picked — and the default is always the real Firefox root.
  if (process.env.MAM_FIREFOX_ROOT) return process.env.MAM_FIREFOX_ROOT;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Mozilla', 'Firefox');
}

// profiles.ini is UTF-16LE with a BOM (measured). Sniff, never assume.
function readProfilesIni(iniPath) {
  const buf = fs.readFileSync(iniPath);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) text = buf.subarray(2).swap16().toString('utf16le');
  else text = buf.toString('utf8');
  return text.replace(/^﻿/, '');
}

// List Firefox profiles that actually have saved logins. A profile with only key4.db (no
// logins.json) is NOT importable and must not appear — it would import zero rows and look broken.
function listFirefoxProfiles(rootOverride) {
  const root = rootOverride || firefoxRoot();
  const iniPath = path.join(root, 'profiles.ini');
  if (!fs.existsSync(iniPath)) return [];
  let text;
  try { text = readProfilesIni(iniPath); } catch { return []; }

  const sections = new Map();
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { current = head[1]; if (!sections.has(current)) sections.set(current, {}); continue; }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    sections.get(current)[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }

  const out = [];
  const seen = new Set();
  for (const [name, values] of sections) {
    if (!/^Profile\d+$/i.test(name)) continue;
    const p = values.Path;
    if (!p) continue;
    const rel = values.IsRelative === undefined ? true : values.IsRelative === '1';
    const profileDir = path.resolve(root, rel ? p : p);
    if (seen.has(profileDir.toLowerCase())) continue;
    seen.add(profileDir.toLowerCase());
    if (!fs.existsSync(path.join(profileDir, 'logins.json'))) continue;
    out.push({ browser: 'Firefox', profile: path.basename(profileDir), profileDir });
  }
  return out;
}

// A saved login is importable only when its stored origin is a real web origin. Firefox keeps
// entries for chrome:// and about: pages (this machine has one chrome:// entry); storing those
// would create a row that can never be filled and can never match a page.
function webHostOf(hostnameField) {
  const raw = String(hostnameField || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!host) return null;
  return host;
}

// Read and decrypt a profile. Throws a FirefoxImportError with a specific, honest message when the
// profile cannot be imported; never returns a silent empty result for a broken profile.
function readFirefoxLogins(profileDir, masterPassword = '') {
  const key4 = path.join(profileDir, 'key4.db');
  const loginsPath = path.join(profileDir, 'logins.json');
  if (!fs.existsSync(key4)) throw new FirefoxImportError(
    'That folder is not a Firefox profile — it has no key4.db. Pick a folder that contains key4.db and logins.json.', 'FIREFOX_NO_KEY4');
  if (!fs.existsSync(loginsPath)) throw new FirefoxImportError(
    'That Firefox profile has no saved logins (no logins.json).', 'FIREFOX_NO_LOGINS');

  const passwordBuf = Buffer.from(masterPassword || '', 'utf8');
  // Work on a private copy of the key database: Firefox may hold it open, and copying means this
  // reader can never be blocked by a lock and never writes a byte into the profile. The copy is
  // deleted in the finally — nothing plaintext is ever derived from it on disk.
  const tmpKey4 = path.join(os.tmpdir(), `mam-key4-${process.pid}-${Date.now()}.db`);
  let candidates;
  try {
    fs.copyFileSync(key4, tmpKey4);
    candidates = sdrCandidates(tmpKey4, passwordBuf);
  } catch (err) {
    if (err instanceof FirefoxImportError) throw err;
    throw new FirefoxImportError('This Firefox profile\'s key4.db could not be read (' + err.message + ') — export the passwords to CSV from Firefox instead.', 'FIREFOX_CORRUPT');
  } finally {
    try { fs.rmSync(tmpKey4, { force: true }); } catch {}
  }

  let data;
  try { data = JSON.parse(fs.readFileSync(loginsPath, 'utf8')); }
  catch { throw new FirefoxImportError('This Firefox profile\'s logins.json is not valid JSON — the file may be damaged.', 'FIREFOX_CORRUPT'); }
  if (!data || !Array.isArray(data.logins)) throw new FirefoxImportError(
    'This Firefox profile\'s logins.json has no saved-login list.', 'FIREFOX_CORRUPT');

  const entries = data.logins;
  const sdr = pickSdr(candidates, entries);

  const logins = [];
  let failed = 0;
  let skippedBlank = 0;
  let skippedNonWeb = 0;
  for (const entry of entries) {
    let username; let password;
    try {
      if (!entry || !entry.encryptedUsername || !entry.encryptedPassword) { failed++; continue; }
      username = decodeLoginField(entry.encryptedUsername, sdr);
      password = decodeLoginField(entry.encryptedPassword, sdr);
    } catch { failed++; continue; }
    // A saved login with no username can never be filled against a form and mergeCredentials drops
    // it anyway; count it so the result can say so instead of looking like a crypto failure.
    if (!username || !password) { skippedBlank++; continue; }
    const host = webHostOf(entry.hostname);
    if (!host) { skippedNonWeb++; continue; }
    logins.push({ host, url: String(entry.hostname || ''), username, password });
  }
  return { logins, scanned: entries.length, failed, skippedBlank, skippedNonWeb, cipher: sdr.cipher };
}

module.exports = {
  listFirefoxProfiles, readFirefoxLogins, webHostOf, firefoxRoot, readProfilesIni,
  FirefoxImportError, pbes2Decrypt, parseSeq, decodeLoginField, sdrCandidates, pickSdr,
  PASSWORD_CHECK, CKA_ID_SDR,
};
