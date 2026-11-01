import crypto from 'node:crypto';

/** A random URL-safe secret and the SHA-256 hash that is stored instead of it. */
export function newSecret(bytes = 32) {
  const secret = crypto.randomBytes(bytes).toString('base64url');
  return { secret, hash: hashSecret(secret) };
}

export const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');
