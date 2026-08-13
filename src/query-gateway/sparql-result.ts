import type { SparqlBindingRow, SparqlBindingValue, SparqlJsonValue } from './types.ts';

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown, depth = 0): value is SparqlJsonValue {
  if (depth > 12) return false;
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every((child) => jsonValue(child, depth + 1));
  if (!plainObject(value)) return false;
  return Object.values(value).every((child) => jsonValue(child, depth + 1));
}

function bindingValue(value: unknown): value is SparqlBindingValue {
  return typeof value === 'string' || (plainObject(value) && jsonValue(value));
}

/** Decode the bindings-only response contract used by fixed internal gateway queries. */
export function normalizeBindingQueryResult(value: unknown): SparqlBindingRow[] {
  if (!plainObject(value) || !plainObject(value.result) || !Array.isArray(value.result.bindings)) {
    throw new Error('DKG query returned an invalid bindings shape');
  }
  return value.result.bindings.map((candidate) => {
    if (!plainObject(candidate) || !Object.values(candidate).every(bindingValue)) {
      throw new Error('DKG query returned an invalid binding term');
    }
    return candidate as SparqlBindingRow;
  });
}
