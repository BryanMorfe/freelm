import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConnectionFields from '../src/components/ConnectionFields';
import { newConnection } from '../src/lib/state';

describe('provider adapter connection settings', () => {
  it('preserves unavailable bindings visibly without presenting a built-in endpoint', () => {
    const connection = newConnection();
    connection.providerAdapter = {
      pluginId: 'missing-plugin',
      providerId: 'adapter',
      accountId: 'account',
      credentialHeader: 'x-api-key',
    };
    const html = renderToStaticMarkup(
      createElement(ConnectionFields, {
        connection,
        updateConnection: () => {},
        secureStorage: false,
      }),
    );
    expect(html).toContain('Unavailable: missing-plugin');
    expect(html).toContain('Credential header');
    expect(html).toContain('x-api-key');
    expect(html).toContain('experimental');
    expect(html).not.toContain('Chat endpoint');
  });
  it('keeps built-in endpoint controls for existing connections', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionFields, {
        connection: newConnection(),
        updateConnection: () => {},
        secureStorage: false,
      }),
    );
    expect(html).toContain('Chat endpoint');
    expect(html).toContain('Built-in OpenAI-compatible API');
    expect(html).not.toContain('Credential header');
  });
});
