import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Sessions live in an encrypted cookie (AES-256-GCM): no session store, and
 * nothing in it is readable or forgeable without SESSION_SECRET. A cookie
 * carries its own expiry, checked on every request.
 */

export interface User {
  /** Stable across sign-ins: the identity provider's issuer and subject, hashed. */
  id: string;
  name: string;
  email: string;
}

export interface Session {
  user: User;
  /** Sent back as X-CSRF-Token on every write. */
  csrf: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** A short-lived cookie holding the single sign-on state between redirect and callback. */
export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  expiresAt: number;
}

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'pi-agent-interface', purpose, 32));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  open<T>(sealed: string | undefined): T | null {
    if (!sealed) return null;
    try {
      const raw = Buffer.from(sealed, 'base64url');
      if (raw.length < 29) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return JSON.parse(text.toString('utf8')) as T;
    } catch {
      return null;
    }
  }
}

export const now = () => Math.floor(Date.now() / 1000);
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

/**
 * A person's stable ID: the identity provider and its subject, hashed, so it
 * fits the platform's agent key format whatever the provider's subject looks
 * like, and two providers' subjects cannot collide.
 */
export function userIdFor(issuer: string, subject: string): string {
  return createHash('sha256').update(`${issuer}\n${subject}`).digest('hex').slice(0, 40);
}
