/**
 * Who may sign in, and who is an administrator, by the groups the identity
 * provider reports (the ID token's, or the userinfo endpoint's, claim).
 *
 * `OIDC_ALLOWED_GROUPS`: when set, only members of these (or of an admin group) may sign in.
 * `OIDC_ADMIN_GROUPS`: when set, the provider decides who is an administrator, on every sign-in.
 * Names are matched exactly; `OIDC_GROUPS_CLAIM` says where the list is (default `groups`).
 */

export interface GroupRules {
  /** The claim holding the person's groups; dotted for a nested one (`realm_access.roles`). */
  claim: string;
  allowed: string[];
  admin: string[];
}

export const DEFAULT_GROUPS_CLAIM = 'groups';

/** Comma-separated names, trimmed, without blanks or repeats. */
export function parseGroupList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

/** The rules, or null when neither list is set (then groups play no part). */
export function groupRules(env: {
  OIDC_GROUPS_CLAIM?: string;
  OIDC_ALLOWED_GROUPS?: string;
  OIDC_ADMIN_GROUPS?: string;
}): GroupRules | null {
  const allowed = parseGroupList(env.OIDC_ALLOWED_GROUPS);
  const admin = parseGroupList(env.OIDC_ADMIN_GROUPS);
  if (allowed.length === 0 && admin.length === 0) return null;
  return { claim: env.OIDC_GROUPS_CLAIM?.trim() || DEFAULT_GROUPS_CLAIM, allowed, admin };
}

/**
 * The groups a set of claims lists: an array, or one string. `undefined` when
 * the claim is not there at all (so the caller can ask the userinfo endpoint),
 * which is different from an empty list.
 */
export function groupsFrom(claims: Record<string, unknown>, claim: string): string[] | undefined {
  let value: unknown = claims[claim];
  if (value === undefined && claim.includes('.')) {
    value = claim.split('.').reduce<unknown>((at, key) => {
      return at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
    }, claims);
  }
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is string => typeof item === 'string').map((s) => s.trim());
}

export interface GroupDecision {
  /** May this person sign in? */
  allowed: boolean;
  /** Administrator by group: true or false when admin groups are set, null when roles are not managed by groups. */
  admin: boolean | null;
}

export function decide(rules: GroupRules, groups: string[]): GroupDecision {
  const has = (wanted: string[]) => wanted.some((name) => groups.includes(name));
  const admin = rules.admin.length > 0 ? has(rules.admin) : null;
  const allowed = rules.allowed.length === 0 || has(rules.allowed) || admin === true;
  return { allowed, admin };
}
