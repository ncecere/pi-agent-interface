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
  /** The person's session version when it began: raising it ends the session (sign out everywhere, suspension). */
  v: number;
}

/** A short-lived cookie holding the single sign-on state between redirect and callback. */
export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  expiresAt: number;
}

/**
 * The secrets that may open sealed values: the current one first, then any
 * previous ones (SESSION_SECRET_PREVIOUS) kept while a rotation completes.
 */
export function secretsOf(config: {
  sessionSecret: string;
  sessionSecretPrevious?: readonly string[];
}): string[] {
  return [config.sessionSecret, ...(config.sessionSecretPrevious ?? [])];
}

export class Sealer {
  private readonly keys: Buffer[];

  /** Seals with the first secret; opens with any of them. */
  constructor(secret: string | readonly string[], purpose: string) {
    const secrets = typeof secret === 'string' ? [secret] : secret;
    this.keys = secrets.map((one) =>
      Buffer.from(hkdfSync('sha256', one, 'pi-agent-interface', purpose, 32)),
    );
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0]!, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }

  /** The value and which secret opened it (0: the current one). */
  private unseal<T>(sealed: string | undefined): { value: T; key: number } | null {
    if (!sealed) return null;
    let raw: Buffer;
    try {
      raw = Buffer.from(sealed, 'base64url');
    } catch {
      return null;
    }
    if (raw.length < 29) return null;
    for (const [index, key] of this.keys.entries()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        return { value: JSON.parse(text.toString('utf8')) as T, key: index };
      } catch {
        // Not this secret (or not JSON): try the next.
      }
    }
    return null;
  }

  open<T>(sealed: string | undefined): T | null {
    return this.unseal<T>(sealed)?.value ?? null;
  }

  /** True when the value opens, but only with a previous secret: seal it again with the current one. */
  needsReseal(sealed: string | undefined): boolean {
    const opened = this.unseal(sealed);
    return opened !== null && opened.key > 0;
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
