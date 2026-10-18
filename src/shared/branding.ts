/** The product's own name, shown when the platform does not name the instance. */
export const DEFAULT_APP_NAME = 'Pi Agents';

/** The instance name to show: the platform's, or the product's. */
export function instanceName(appName: string | null | undefined): string {
  return appName?.trim() || DEFAULT_APP_NAME;
}
