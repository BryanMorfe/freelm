import type { Connection } from '../types';
import { assertModelCatalog } from './catalog';
export function assertConnection(connection: Connection) {
  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS API base URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.',
    );
  if (connection.providerAdapter && (!validProviderAdapterBinding(connection.providerAdapter) || connection.chatApi !== 'chat/completions')) throw new Error('Invalid provider adapter binding. Re-select the adapter.');
  if (!connection.name.trim()) throw new Error('Give each connection a name.');
  if (connection.catalog) assertModelCatalog(connection.catalog);
}

export function validProviderAdapterBinding(value: unknown): boolean {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const binding = value as Record<string, unknown>;
 return Object.keys(binding).every(key => ['pluginId','accountId','providerId','credentialHeader'].includes(key)) && ['pluginId','accountId','providerId'].every(key => typeof binding[key] === 'string' && (binding[key] as string).trim().length > 0 && (binding[key] as string).length <= 256) && ['authorization','x-api-key'].includes(String(binding.credentialHeader));
}
