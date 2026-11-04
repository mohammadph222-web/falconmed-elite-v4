/**
 * Authenticator-app codes (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits),
 * the encryption of their secrets at rest, and one-time recovery codes.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { hashSecret } from './tokens.js';

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/** The code for one time step. */
export function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/**
 * The step a code belongs to, allowing one step of clock drift either way,
 * or null when it matches none. Callers reject steps at or before the last one used.
 */
export function matchStep(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code ?? ''))) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, s)), Buffer.from(String(code)))) return s;
  }
  return null;
}

export const otpauthUrl = ({ secret, email, issuer = 'FalconMed Elite' }) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ── encryption at rest ───────────────────────────────────────────
const key = () => crypto.createHash('sha256').update(env.DATA_ENCRYPTION_KEY ?? `dev-only:${env.JWT_SECRET}`).digest();

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(stored) {
  const [v, iv, tag, data] = String(stored).split('.');
  if (v !== 'v1') throw new Error('unknown encryption version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ── recovery codes ───────────────────────────────────────────────
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const normaliseRecovery = (code) => String(code).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Ten one-time codes like "k7mq-2xpd", and the hashes that are stored. */
export function newRecoveryCodes(count = 10) {
  const codes = Array.from({ length: count }, () => {
    const c = Array.from(crypto.randomBytes(8), (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  });
  return { codes, hashes: codes.map((c) => hashSecret(normaliseRecovery(c))) };
}

export const recoveryHash = (code) => hashSecret(normaliseRecovery(code));
