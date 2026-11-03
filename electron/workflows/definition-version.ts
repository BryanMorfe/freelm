import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function definitionHash(definition: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(definition)))
    .digest('hex');
}
export interface DefinitionBase {
  expectedRevision?: number;
  expectedContentHash?: string;
}
