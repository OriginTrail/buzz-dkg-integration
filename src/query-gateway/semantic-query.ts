import { IntegrationApiError } from '../errors.ts';
import { enforceSemanticQueryPolicy, SEMANTIC_QUERY_MAX_QUADS } from './sparql-policy.ts';
import type {
  SemanticQueryResult,
  SemanticQueryView,
  SparqlBindingRow,
  SparqlBindingValue,
  SparqlJsonValue,
  SparqlQuad,
  VisibleMemoryLayer,
} from './types.ts';

export type SemanticVisibleView = 'shared-working-memory' | 'verifiable-memory';

export interface NormalizedSparqlResult {
  bindings: SparqlBindingRow[];
  quads?: SparqlQuad[];
}

export type SemanticQueryRunner = (
  view: SemanticVisibleView,
  sparql: string,
  timeoutMs: number,
) => Promise<NormalizedSparqlResult>;

const VIEWS: readonly [SemanticVisibleView, VisibleMemoryLayer][] = [
  ['shared-working-memory', 'SWM'],
  ['verifiable-memory', 'VM'],
];
const MAX_SEMANTIC_ROWS = 100;
const MAX_SEMANTIC_QUERY_TIMEOUT_MS = 10_000;

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

/** Validate the DKG response before it crosses the public semantic-query boundary. */
export function normalizeSparqlResult(value: unknown): NormalizedSparqlResult {
  if (!plainObject(value) || !plainObject(value.result) || !Array.isArray(value.result.bindings)) {
    throw new Error('DKG query returned an invalid bindings shape');
  }
  const bindings: SparqlBindingRow[] = [];
  for (const candidate of value.result.bindings) {
    if (!plainObject(candidate) || !Object.values(candidate).every(bindingValue)) {
      throw new Error('DKG query returned an invalid binding term');
    }
    bindings.push(candidate as SparqlBindingRow);
  }
  const rawQuads = value.result.quads;
  if (rawQuads !== undefined && !Array.isArray(rawQuads)) {
    throw new Error('DKG query returned an invalid quads shape');
  }
  const quads = rawQuads?.map((quad) => {
    if (!plainObject(quad) || !jsonValue(quad)) {
      throw new Error('DKG query returned an invalid quad');
    }
    return quad as SparqlQuad;
  });
  return { bindings, ...(quads ? { quads } : {}) };
}

/** Parser-level validation owns shape only; configured size policy is enforced at execution. */
export function requiredSemanticSparql(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new IntegrationApiError(400, 'invalid_request', 'arguments.sparql is invalid');
  }
  return value.trim();
}

export async function executeSemanticQuery(options: {
  sparql: string;
  selectedView: SemanticQueryView;
  maxQueryBytes: number;
  dkgTimeoutMs: number;
  query: SemanticQueryRunner;
}): Promise<SemanticQueryResult> {
  const policy = enforceSemanticQueryPolicy(options.sparql, options.maxQueryBytes);
  const views = VIEWS.filter(([, layer]) => {
    if (options.selectedView === 'both') return true;
    return options.selectedView === 'shared' ? layer === 'SWM' : layer === 'VM';
  });
  const timeoutMs = Math.min(options.dkgTimeoutMs, MAX_SEMANTIC_QUERY_TIMEOUT_MS);
  const layers = await Promise.all(
    views.map(async ([view, layer]) => {
      const result = await options.query(view, options.sparql, timeoutMs);
      if (result.quads && result.quads.length > SEMANTIC_QUERY_MAX_QUADS) {
        throw new IntegrationApiError(
          502,
          'result_bound_exceeded',
          'DKG returned more CONSTRUCT quads than the verified query bound',
          { maxQuads: SEMANTIC_QUERY_MAX_QUADS, receivedQuads: result.quads.length },
        );
      }
      return {
        layer,
        bindings: result.bindings.slice(0, MAX_SEMANTIC_ROWS),
        ...(result.quads ? { quads: result.quads } : {}),
      };
    }),
  );
  return {
    queryType: policy.queryType,
    scope: { type: 'current_channel' },
    cost: { score: policy.score, budget: policy.budget, metrics: policy.metrics },
    layers,
  };
}
