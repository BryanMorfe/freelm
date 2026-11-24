import type { AppState } from '../types';
export const ONBOARDING_VERSION = 1;
export const ONBOARDING_KEY = 'freelm-onboarding-v1';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
function storage(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
// Announcements have a separate version. No release content is implied by completing setup.
export function onboardingSeen(store = storage()): boolean {
  try {
    const value = JSON.parse(store?.getItem(ONBOARDING_KEY) || 'null');
    return value?.version === 1 && value.welcomeVersion >= ONBOARDING_VERSION;
  } catch {
    return false;
  }
}
export function finishOnboarding(store = storage()) {
  let announcementVersion: string | null = null;
  try {
    const old = JSON.parse(store?.getItem(ONBOARDING_KEY) || 'null');
    if (typeof old?.announcementVersion === 'string') announcementVersion = old.announcementVersion;
  } catch {
    // A damaged preference record must not prevent saving welcome completion.
  }
  try {
    store?.setItem(
      ONBOARDING_KEY,
      JSON.stringify({
        version: 1,
        welcomeVersion: ONBOARDING_VERSION,
        announcementVersion,
      }),
    );
  } catch {
    /* Session dismissal still works with unavailable storage. */
  }
}
export function isUnconfiguredWorkspace(state: AppState): boolean {
  return (
    !state.threads.length &&
    !state.projects.length &&
    !state.generations.length &&
    state.connections.length === 1 &&
    state.connections.every(
      (c) =>
        c.name === 'Local API' &&
        c.baseUrl === 'http://localhost:8000/v1' &&
        !c.apiKey &&
        !c.catalog?.length &&
        !c.discoveredModels.length &&
        !Object.values(c.models).some(Boolean),
    )
  );
}
