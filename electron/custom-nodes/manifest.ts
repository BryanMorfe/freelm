import type { CustomNodeManifest } from '../../src/custom-node-types';
const id = (x: unknown) =>
  typeof x === 'string' &&
  /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(x) &&
  !['constructor', 'prototype', '__proto__'].includes(x);
export function validateNodeManifest(input: unknown): asserts input is CustomNodeManifest {
  const m = input as CustomNodeManifest;
  if (
    !m ||
    !id(m.id) ||
    !/^\d+\.\d+\.\d+$/.test(m.version) ||
    typeof m.title !== 'string' ||
    !m.title ||
    m.title.length > 200 ||
    typeof m.description !== 'string' ||
    m.description.length > 4000
  )
    throw new Error('Invalid custom node identity.');
  for (const ports of [m.inputs, m.outputs]) {
    if (!Array.isArray(ports) || ports.length > 32)
      throw new Error('Custom nodes support at most 32 ports per direction.');
    const names = new Set();
    for (const p of ports) {
      if (
        !id(p.id) ||
        names.has(p.id) ||
        typeof p.label !== 'string' ||
        p.label.length > 200 ||
        ![
          'any',
          'text',
          'number',
          'boolean',
          'object',
          'list',
          'image',
          'video',
          'audio',
          'file',
          'signal',
        ].includes(p.type)
      )
        throw new Error('Invalid custom node port.');
      names.add(p.id);
    }
  }
  if (!Array.isArray(m.fields) || m.fields.length > 64)
    throw new Error('Invalid custom node fields.');
  const keys = new Set();
  for (const f of m.fields) {
    if (
      !id(f.key) ||
      keys.has(f.key) ||
      typeof f.label !== 'string' ||
      f.label.length > 200 ||
      ![
        'text',
        'textarea',
        'number',
        'json',
        'select',
        'boolean',
        'lines',
        'secret',
        undefined,
      ].includes(f.kind)
    )
      throw new Error('Invalid custom node field.');
    keys.add(f.key);
    if (
      f.options &&
      (!Array.isArray(f.options) ||
        f.options.some((o) => typeof o.value !== 'string' || typeof o.label !== 'string'))
    )
      throw new Error('Invalid field options.');
  }
  if (!m.permissions || typeof m.permissions !== 'object' || Array.isArray(m.permissions))
    throw new Error('Explicit permissions are required.');
  if (
    m.permissions.network !== undefined &&
    (!Array.isArray(m.permissions.network) ||
      m.permissions.network.length > 32 ||
      m.permissions.network.some((origin) => {
        try {
          const u = new URL(origin);
          return u.origin !== origin || u.protocol !== 'https:';
        } catch {
          return true;
        }
      }))
  )
    throw new Error('Network permissions require exact HTTPS origins.');
  if (m.permissions.inference !== undefined && typeof m.permissions.inference !== 'boolean')
    throw new Error('Invalid inference permission.');
  if (m.discovery !== undefined && typeof m.discovery !== 'boolean')
    throw new Error('Invalid discovery declaration.');
  if (m.retrySafe !== undefined && typeof m.retrySafe !== 'boolean')
    throw new Error('Invalid retry policy.');
}
export function validatePortValues(
  ports: CustomNodeManifest['inputs'],
  values: Record<string, unknown>,
) {
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('Node values must be a named object.');
  for (const p of ports) {
    const v = values[p.id];
    if (v === undefined) {
      if (p.required) throw new Error(`Missing required port: ${p.id}`);
      continue;
    }
    const ok =
      p.type === 'any' ||
      p.type === 'signal' ||
      (p.type === 'text'
        ? typeof v === 'string'
        : p.type === 'number'
          ? typeof v === 'number' && Number.isFinite(v)
          : p.type === 'boolean'
            ? typeof v === 'boolean'
            : p.type === 'list'
              ? Array.isArray(v)
              : p.type === 'object'
                ? v !== null && typeof v === 'object' && !Array.isArray(v)
                : v !== null && typeof v === 'object');
    if (!ok) throw new Error(`Invalid value for ${p.id} (${p.type}).`);
  }
}
