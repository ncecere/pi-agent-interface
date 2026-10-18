/**
 * Optional features: parts of the app an administrator can turn on or off
 * while it runs (Admin → Features), each declared once here.
 *
 * How the app's settings divide up:
 *
 * - **Environment** (config.ts): facts about the deployment. Where the
 *   platform is, secrets, sign-in. Changing one means a restart.
 * - **Instance settings** (Admin → Branding, Agents): how this instance
 *   looks and behaves for everyone. Stored in the database.
 * - **Optional features** (this file, Admin → Features): whole capabilities
 *   that some instances want and others do not. A boolean each, with a
 *   default, stored in the database under the `features` setting. The server
 *   enforces them (their routes refuse when off) and `/api/me` tells the
 *   browser, which hides what is off. `DISABLED_FEATURES` in the environment
 *   turns one off for good, for a deployment where it cannot work (a platform
 *   without the API it needs); administrators then see it locked.
 * - **Personal preferences** (Settings): each person's own, synced to their
 *   account.
 *
 * To add a feature: declare it below; guard its routes with `feature(c, id)`
 * in app.ts; hide its screens with `useFeature(id)` in the browser.
 */
export const FEATURES = {
  usage: {
    label: 'Usage',
    description:
      "Administrators see how much each person's agents use their models: requests, tokens and an estimated cost, from the platform's usage reports.",
    default: true,
  },
} as const satisfies Record<string, { label: string; description: string; default: boolean }>;

export type FeatureId = keyof typeof FEATURES;
export type Features = Record<FeatureId, boolean>;

export const FEATURE_IDS = Object.keys(FEATURES) as FeatureId[];

export const isFeatureId = (id: string): id is FeatureId => id in FEATURES;

/** What is on: the defaults, then what administrators saved, then what the environment locks off. */
export function resolveFeatures(saved: unknown, disabled: readonly string[] = []): Features {
  const chosen = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  return Object.fromEntries(
    FEATURE_IDS.map((id) => [
      id,
      !disabled.includes(id) &&
        (typeof chosen[id] === 'boolean' ? (chosen[id] as boolean) : FEATURES[id].default),
    ]),
  ) as Features;
}

/** An administrator's change: known features, booleans, nothing locked turned on. */
export function parseFeatureChange(
  body: unknown,
  disabled: readonly string[] = [],
): { value: Partial<Features> } | { problems: Record<string, string> } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { problems: { body: 'Send an object of feature names and true or false.' } };
  const problems: Record<string, string> = {};
  const value: Partial<Features> = {};
  for (const [id, on] of Object.entries(body)) {
    if (!isFeatureId(id)) problems[id] = 'There is no such feature.';
    else if (typeof on !== 'boolean') problems[id] = 'On or off: true or false.';
    else if (on && disabled.includes(id))
      problems[id] = 'This deployment turns it off (DISABLED_FEATURES).';
    else value[id] = on;
  }
  return Object.keys(problems).length ? { problems } : { value };
}
