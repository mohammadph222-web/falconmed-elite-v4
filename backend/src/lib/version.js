import { readFileSync } from 'node:fs';

/** Single source for the API version: backend/package.json. */
export const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
