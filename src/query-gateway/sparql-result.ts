import type { SparqlBindingRow, SparqlBindingValue, SparqlJsonValue, SparqlQuad } from './types.ts';

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

function resultRecord(value: unknown): Record<string, unknown> {
  if (!plainObject(value) || !plainObject(value.result)) {
    throw new Error('DKG query returned an invalid result shape');
  }
  return value.result;
}

/** Decode the bindings-only response contract used by fixed internal gateway queries. */
export function normalizeBindingQueryResult(value: unknown): SparqlBindingRow[] {
  const result = resultRecord(value);
  if (!Array.isArray(result.bindings)) {
    throw new Error('DKG query returned an invalid bindings shape');
  }
  return result.bindings.map((candidate) => {
    if (!plainObject(candidate) || !Object.values(candidate).every(bindingValue)) {
      throw new Error('DKG query returned an invalid binding term');
    }
    return candidate as SparqlBindingRow;
  });
}

/** Decode the boolean result contract used by ASK queries. */
export function normalizeAskQueryResult(value: unknown): boolean {
  const result = resultRecord(value);
  if (typeof result.boolean !== 'boolean') {
    throw new Error('DKG ASK query returned an invalid boolean shape');
  }
  return result.boolean;
}

/** Decode the graph result contract used by CONSTRUCT queries. */
export function normalizeQuadQueryResult(value: unknown): SparqlQuad[] {
  const result = resultRecord(value);
  if (!Array.isArray(result.quads)) {
    throw new Error('DKG CONSTRUCT query returned an invalid quads shape');
  }
  return result.quads.map((quad) => {
    if (!plainObject(quad) || !jsonValue(quad)) {
      throw new Error('DKG query returned an invalid quad');
    }
    return quad as SparqlQuad;
  });
}
