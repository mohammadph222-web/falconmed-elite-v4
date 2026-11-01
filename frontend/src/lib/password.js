/** Mirrors the server's rule (backend/src/lib/passwords.js). */
export const PASSWORD_RULES = [
  [(p) => p.length >= 10, 'At least 10 characters'],
  [(p) => /[A-Za-z]/.test(p), 'A letter'],
  [(p) => /\d/.test(p), 'A number'],
];

export const passwordOk = (p) => PASSWORD_RULES.every(([ok]) => ok(p));
