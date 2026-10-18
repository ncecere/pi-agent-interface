/// <reference types="vite/client" />

/** Development only (vite.config.ts): the platform the dev proxy talks to. */
declare const __DEV_PLATFORM__: {
  url: string;
  remote: boolean;
  session: boolean;
  cookieName: string;
} | null;
