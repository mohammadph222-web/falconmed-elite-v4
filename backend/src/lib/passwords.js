import crypto from 'node:crypto';
import { z } from 'zod';

/** At least 8 characters, with a letter and a digit. */
export const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/\d/, 'Include at least one number');

// No look-alike characters (0/O, 1/l/I), so it can be read out or typed from a note.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random temporary password such as "Kp7w-Rt2m-Xq9v". Always passes newPasswordSchema. */
export function temporaryPassword() {
  const group = () => Array.from(crypto.randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join('');
  let pw;
  do pw = `${group()}-${group()}-${group()}`;
  while (!/[A-Za-z]/.test(pw) || !/\d/.test(pw));
  return pw;
}
