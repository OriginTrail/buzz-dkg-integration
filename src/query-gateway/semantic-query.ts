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

export type SemanticQueryRunner = (
  view: SemanticVisibleView,
  sparql: string,
  timeoutMs: number,
) => Promise<unknown>;

const VIEWS: readonly [SemanticVisibleView, VisibleMemoryLayer][] = [
  ['shared-working-memory', 'SWM'],
  ['verifiable-memory', 'VM'],
];
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

function semanticResult(value: unknown): Record<string, unknown> {
  if (!plainObject(value) || !plainObject(value.result)) {
    throw new Error('DKG query returned an invalid result shape');
  }
  return value.result;
}

function selectBindings(value: unknown, limit: number): SparqlBindingRow[] {
  const result = semanticResult(value);
  if (!Array.isArray(result.bindings)) {
    throw new Error('DKG SELECT query returned an invalid bindings shape');
  }
  return result.bindings.slice(0, limit).map((candidate) => {
    if (!plainObject(candidate) || !Object.values(candidate).every(bindingValue)) {
      throw new Error('DKG query returned an invalid binding term');
    }
    return candidate as SparqlBindingRow;
  });
}

function askBoolean(value: unknown): boolean {
  const result = semanticResult(value);
  if (typeof result.boolean !== 'boolean') {
    throw new Error('DKG ASK query returned an invalid boolean shape');
  }
  return result.boolean;
}

function constructQuads(value: unknown, maximumQuads: number): SparqlQuad[] {
  const result = semanticResult(value);
  if (!Array.isArray(result.quads)) {
    throw new Error('DKG CONSTRUCT query returned an invalid quads shape');
  }
  if (result.quads.length > maximumQuads) {
    throw new IntegrationApiError(
      502,
      'result_bound_exceeded',
      'DKG returned more CONSTRUCT quads than the verified query bound',
      { maxQuads: maximumQuads, receivedQuads: result.quads.length },
    );
  }
  return result.quads.map((quad) => {
    if (!plainObject(quad) || !jsonValue(quad)) {
      throw new Error('DKG query returned an invalid quad');
    }
    return quad as SparqlQuad;
  });
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
  const base = {
    scope: { type: 'current_channel' },
    cost: { score: policy.score, budget: policy.budget, metrics: policy.metrics },
  } as const;
  if (policy.queryType === 'select') {
    const layers = await Promise.all(
      views.map(async ([view, layer]) => ({
        layer,
        bindings: selectBindings(
          await options.query(view, options.sparql, timeoutMs),
          policy.limit!,
        ),
      })),
    );
    return { ...base, queryType: 'select', layers };
  }
  if (policy.queryType === 'ask') {
    const layers = await Promise.all(
      views.map(async ([view, layer]) => ({
        layer,
        boolean: askBoolean(await options.query(view, options.sparql, timeoutMs)),
      })),
    );
    return { ...base, queryType: 'ask', layers };
  }
  const maximumQuads = Math.min(
    SEMANTIC_QUERY_MAX_QUADS,
    policy.metrics.constructTriples * policy.limit!,
  );
  const layers = await Promise.all(
    views.map(async ([view, layer]) => ({
      layer,
      quads: constructQuads(await options.query(view, options.sparql, timeoutMs), maximumQuads),
    })),
  );
  return {
    ...base,
    queryType: 'construct',
    layers,
  };
}
