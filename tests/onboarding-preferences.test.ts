import { describe, expect, it } from 'vitest';
import { initialState } from '../src/lib/state';
import {
  finishOnboarding,
  onboardingSeen,
  isUnconfiguredWorkspace,
  ONBOARDING_KEY,
} from '../src/lib/onboarding-preferences';
import { assertConnection } from '../src/lib/connection-validation';
describe('onboarding boundaries', () => {
  it('keeps welcome completion separate from release announcements', () => {
    let raw = JSON.stringify({ version: 1, announcementVersion: 'release-x' });
    const store = {
      getItem: () => raw,
      setItem: (key: string, value: string) => {
        expect(key).toBe(ONBOARDING_KEY);
        raw = value;
      },
    };
    expect(onboardingSeen(store)).toBe(false);
    finishOnboarding(store);
    expect(onboardingSeen(store)).toBe(true);
    expect(JSON.parse(raw).announcementVersion).toBe('release-x');
  });
  it('only auto-opens for an untouched workspace', () => {
    const state = initialState();
    expect(isUnconfiguredWorkspace(state)).toBe(true);
    state.connections[0].baseUrl = 'http://localhost:1234/v1';
    expect(isUnconfiguredWorkspace(state)).toBe(false);
  });
  it('recovers from unavailable preference storage', () => {
    const store = {
      getItem: () => {
        throw Error('unavailable');
      },
      setItem: () => {
        throw Error('unavailable');
      },
    };
    expect(onboardingSeen(store)).toBe(false);
    expect(() => finishOnboarding(store)).not.toThrow();
  });
  it('rejects embedded credentials and malformed endpoints before discovery/save', () => {
    const connection = initialState().connections[0];
    for (const baseUrl of [
      'invalid',
      'file:///tmp/api',
      'https://user:secret@example.com/v1',
      'https://example.com/v1?key=secret',
    ])
      expect(() => assertConnection({ ...connection, baseUrl })).toThrow();
    expect(() => assertConnection(connection)).not.toThrow();
  });
});
