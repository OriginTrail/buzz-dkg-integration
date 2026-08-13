import { IntegrationApiError } from '../errors.ts';
import { enforceSemanticQueryPolicy, SEMANTIC_QUERY_MAX_QUADS } from './sparql-policy.ts';
import {
  normalizeAskQueryResult,
  normalizeBindingQueryResult,
  normalizeQuadQueryResult,
} from './sparql-result.ts';
import type { SemanticQueryResult, SemanticQueryView, VisibleMemoryLayer } from './types.ts';

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

function constructQuads(value: unknown, maximumQuads: number) {
  const quads = normalizeQuadQueryResult(value);
  if (quads.length > maximumQuads) {
    throw new IntegrationApiError(
      502,
      'result_bound_exceeded',
      'DKG returned more CONSTRUCT quads than the verified query bound',
      { maxQuads: maximumQuads, receivedQuads: quads.length },
    );
  }
  return quads;
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
        bindings: normalizeBindingQueryResult(
          await options.query(view, options.sparql, timeoutMs),
        ).slice(0, policy.limit),
      })),
    );
    return { ...base, queryType: 'select', layers };
  }
  if (policy.queryType === 'ask') {
    const layers = await Promise.all(
      views.map(async ([view, layer]) => ({
        layer,
        boolean: normalizeAskQueryResult(await options.query(view, options.sparql, timeoutMs)),
      })),
    );
    return { ...base, queryType: 'ask', layers };
  }
  const maximumQuads = Math.min(
    SEMANTIC_QUERY_MAX_QUADS,
    policy.metrics.constructTriples * policy.limit,
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
