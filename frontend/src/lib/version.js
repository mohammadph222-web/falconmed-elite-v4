import { version } from '../../package.json';

/** Shown in the sidebar and on the login screen; comes from frontend/package.json. */
export const APP_VERSION = version.split('.').slice(0, 2).join('.');
