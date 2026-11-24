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
  it.each(['{', '{"version":1,"announcementVersion":"release-x"', 'not-json'])(
    'replaces malformed preferences and durably completes onboarding: %s',
    (initial) => {
      const values = new Map([
        [ONBOARDING_KEY, initial],
        ['freelm-navigation-v1', '{"surface":"code"}'],
      ]);
      const store = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      };
      expect(onboardingSeen(store)).toBe(false);
      finishOnboarding(store);
      expect(JSON.parse(values.get(ONBOARDING_KEY)!)).toEqual({
        version: 1,
        welcomeVersion: 1,
        announcementVersion: null,
      });
      // A fresh reader observes completion; no in-memory flag can hide a failed write.
      expect(onboardingSeen({ ...store })).toBe(true);
      expect(values.get('freelm-navigation-v1')).toBe('{"surface":"code"}');
    },
  );
  it.each([null, '', 'null', '[]', '"old preference"', '1'])(
    'normalizes missing or non-object preferences: %s',
    (initial) => {
      let raw = initial;
      const store = {
        getItem: () => raw,
        setItem: (_key: string, value: string) => {
          raw = value;
        },
      };
      finishOnboarding(store);
      expect(onboardingSeen(store)).toBe(true);
      expect(JSON.parse(raw!)).toEqual({
        version: 1,
        welcomeVersion: 1,
        announcementVersion: null,
      });
    },
  );
  it.each(['{', '{"version":1,"welcomeVersion":0,"announcementVersion":"release-x"}'])(
    'preserves the existing record on a failed write and permits a later retry: %s',
    (initial) => {
      let raw = initial,
        fail = true;
      const store = {
        getItem: () => raw,
        setItem: (_key: string, value: string) => {
          if (fail) throw new Error('Storage quota exceeded');
          raw = value;
        },
      };
      expect(() => finishOnboarding(store)).not.toThrow();
      expect(raw).toBe(initial);
      expect(onboardingSeen(store)).toBe(false);
      fail = false;
      finishOnboarding(store);
      expect(onboardingSeen(store)).toBe(true);
      expect(JSON.parse(raw).announcementVersion).toBe(initial === '{' ? null : 'release-x');
    },
  );
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
