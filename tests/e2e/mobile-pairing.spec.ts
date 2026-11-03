import { expect, test } from '@playwright/test';

// Production component, isolated browser state and synthetic IPC; no desktop app/profile.
test('iPhone pairing shows QR, expiry, revocation, errors and stopped state', async ({ page }) => {
  await page.addInitScript(() => {
    const state: any = { enabled: true, endpoint: 'https://synthetic.invalid:4320', sessions: [] };
    const control: any = { state, revoked: [], fail: false, ttl: 120000 };
    (window as any).__pairing = control;
    (window as any).desktop = {
      mobileStatus: async () => structuredClone(state),
      mobileInvite: async () => {
        if (control.fail) throw new Error('Synthetic invitation failure');
        const invitation = {
          version: 2,
          endpoint: state.endpoint,
          hostId: 'synthetic-mac',
          hostName: 'Synthetic Mac',
          certificateSHA256: 'a'.repeat(64),
          id: 'fixture-invitation',
          secret: 'synthetic-not-a-credential',
          expiresAt: Date.now() + control.ttl,
        };
        state.invitation = { id: invitation.id, expiresAt: invitation.expiresAt };
        return invitation;
      },
      mobileRevoke: async (id: string) => {
        control.revoked.push(id);
        state.invitation = undefined;
        state.sessions = [];
      },
      mobileStop: async () => {
        state.enabled = false;
        state.invitation = undefined;
        state.sessions = [];
      },
    };
  });
  await page.route('**/__mobile-pairing-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
 import RefreshRuntime from '/@react-refresh';
 RefreshRuntime.injectIntoGlobalHook(window);
 window.$RefreshReg$ = () => {};
 window.$RefreshSig$ = () => (type) => type;
 window.__vite_plugin_react_preamble_installed__ = true;
 </script><script type="module">
 import React from '/node_modules/.vite/deps/react.js';
 import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
 import Component from '/src/components/MobilePairingSettings.tsx';
 import '/src/styles.css';
 ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Component));
 </script></body></html>`,
    }),
  );
  page.on('dialog', (dialog) => dialog.accept());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/__mobile-pairing-test');
  const generate = page.getByRole('button', { name: 'Generate pairing code' });
  await expect(generate).toBeVisible();
  await generate.click();
  const qr = page.getByAltText('Single-use iPhone Bots pairing code');
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);
  await page.getByText('Enter manually', { exact: true }).click();
  await expect(page.getByLabel('Manual pairing invitation')).toHaveValue(
    /synthetic-not-a-credential/,
  );
  await page.getByRole('button', { name: 'Cancel code' }).click();
  await expect(qr).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pairing.revoked)).toEqual([
    'fixture-invitation',
  ]);
  await page.clock.install();
  await generate.click();
  await expect(qr).toBeVisible();
  await page.clock.fastForward(121000);
  await expect(qr).toHaveCount(0, { timeout: 6000 });
  await expect(
    page.getByText('The code expired or was used. Generate a new code if needed.'),
  ).toBeVisible();
  await page.evaluate(() => {
    const c = (window as any).__pairing;
    c.state.invitation = undefined;
    c.state.sessions = [{ id: 'fixture-session', expiresAt: Date.now() + 60000 }];
  });
  await expect(generate).toBeDisabled();
  await page.getByRole('button', { name: 'Revoke iPhone access' }).click();
  await expect(generate).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__pairing.revoked)).toContain('fixture-session');
  await page.evaluate(() => {
    (window as any).__pairing.fail = true;
  });
  await generate.click();
  await expect(page.getByRole('alert')).toContainText('Synthetic invitation failure');
  await page.getByRole('button', { name: 'Stop iPhone sharing' }).click();
  await expect(page.getByText('Not enabled', { exact: true })).toBeVisible();
  await expect(generate).toHaveCount(0);
  expect(errors).toEqual([]);
});
