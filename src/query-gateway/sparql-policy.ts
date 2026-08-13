import { Parser } from '@traqula/parser-sparql-1-1';
import type {
  Expression,
  Path,
  Pattern,
  Query,
  QueryAsk,
  QueryConstruct,
  QuerySelect,
  SparqlQuery,
  SolutionModifierGroupBind,
  TermVariable,
} from '@traqula/rules-sparql-1-1';
import { IntegrationApiError } from '../errors.ts';
import type { SemanticQueryMetrics } from './types.ts';

export const SEMANTIC_QUERY_MAX_LIMIT = 100;
export const SEMANTIC_QUERY_DEFAULT_LIMIT = 25;
export const SEMANTIC_QUERY_COST_BUDGET = 40;
export const SEMANTIC_QUERY_MAX_QUADS = 300;

export interface SemanticQueryPolicyResult {
  queryType: 'select' | 'ask' | 'construct';
  limit: number | null;
  offset: number;
  score: number;
  budget: number;
  metrics: SemanticQueryMetrics;
}

const parser = new Parser();
const MAX_TRIPLES = 16;
const MAX_OPTIONALS = 6;
const MAX_UNION_BRANCHES = 4;
const MAX_SUBQUERIES = 0;
const MAX_VALUES_ROWS = 50;
const MAX_GRAPH_PATTERNS = 4;

function policyError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new IntegrationApiError(status, code, message, details);
}

function unsafe(message: string, suggestions: string[]): never {
  policyError(400, 'unsafe_query', message, { suggestions });
}

function variableName(value: { type: string; subType: string; value?: string }): string | null {
  return value.type === 'term' && value.subType === 'variable' ? (value.value ?? '') : null;
}

function queryLimit(ast: Query): number | null {
  return ast.solutionModifiers.limitOffset?.limit ?? null;
}

function queryOffset(ast: Query): number {
  return ast.solutionModifiers.limitOffset?.offset ?? 0;
}

function valuesAnchors(value: Pattern): Set<string> {
  const anchors = new Set<string>();
  if (value.type !== 'pattern' || value.subType !== 'values') return anchors;
  for (const variable of value.variables) {
    const name = variableName(variable);
    if (name && value.values.some((row) => row[name] !== undefined)) anchors.add(name);
  }
  return anchors;
}

function validatePatternList(
  patterns: Pattern[],
  inheritedAnchors: ReadonlySet<string>,
  violations: string[],
): void {
  const anchors = new Set(inheritedAnchors);
  // VALUES is join-compatible with its mandatory siblings regardless of textual order. Only
  // direct siblings contribute here: bindings inside OPTIONAL or one UNION arm must not escape.
  for (const pattern of patterns) {
    for (const name of valuesAnchors(pattern)) anchors.add(name);
  }
  for (const pattern of patterns) validateBroadScans(pattern, anchors, violations);
}

function validateBroadScans(
  value: Pattern,
  inheritedAnchors: ReadonlySet<string>,
  violations: string[],
): void {
  if (value.type === 'query') {
    validatePatternList(value.where.patterns, inheritedAnchors, violations);
    return;
  }
  if (value.subType === 'values') return;
  if (value.subType === 'union') {
    for (const branch of value.patterns) validateBroadScans(branch, inheritedAnchors, violations);
    return;
  }
  if (value.subType === 'bgp') {
    for (const triple of value.triples) {
      if (triple.type !== 'triple') continue;
      const subject = variableName(triple.subject);
      const predicate = variableName(triple.predicate);
      const objectName = variableName(triple.object);
      if (
        subject &&
        predicate &&
        objectName &&
        !inheritedAnchors.has(subject) &&
        !inheritedAnchors.has(predicate) &&
        !inheritedAnchors.has(objectName)
      ) {
        violations.push('fully unbound triple pattern is not allowed');
      }
    }
    return;
  }
  if (
    value.subType === 'group' ||
    value.subType === 'optional' ||
    value.subType === 'minus' ||
    value.subType === 'graph' ||
    value.subType === 'service'
  ) {
    validatePatternList(value.patterns, inheritedAnchors, violations);
  }
}

interface SemanticQueryAnalysis {
  metrics: SemanticQueryMetrics;
  violations: string[];
}

type AllowedQuery = QuerySelect | QueryAsk | QueryConstruct;

interface AnalysisState extends SemanticQueryAnalysis {
  valuesBoundVariables: Set<string>;
}

function collectValueBindings(pattern: Pattern, bindings: Set<string>): void {
  if (pattern.type === 'query') {
    if (pattern.values) collectValueBindings(pattern.values, bindings);
    collectValueBindings(pattern.where, bindings);
    return;
  }
  if (pattern.subType === 'values') {
    for (const variable of pattern.variables) {
      const name = variableName(variable);
      if (name && pattern.values.some((row) => row[name] !== undefined)) bindings.add(name);
    }
    return;
  }
  if (
    pattern.subType === 'group' ||
    pattern.subType === 'union' ||
    pattern.subType === 'optional' ||
    pattern.subType === 'minus' ||
    pattern.subType === 'graph' ||
    pattern.subType === 'service'
  ) {
    for (const child of pattern.patterns) collectValueBindings(child, bindings);
  }
}

function analyzePath(path: Path | TermVariable, state: AnalysisState): void {
  if (path.type !== 'path') return;
  state.metrics.propertyPaths += 1;
  if (path.subType === '*' || path.subType === '+' || path.subType === '!') {
    state.violations.push(`property path '${path.subType}' is not bounded`);
  }
  for (const item of path.items) analyzePath(item, state);
}

function analyzeExpression(expression: Expression, state: AnalysisState): void {
  if (expression.type !== 'expression') return;
  if (expression.subType === 'aggregate') {
    state.metrics.aggregates += 1;
    for (const child of expression.expression) {
      if (child.type !== 'wildcard') analyzeExpression(child, state);
    }
    return;
  }
  if (expression.subType === 'patternOperation') {
    analyzePattern(expression.args, state);
    return;
  }
  for (const child of expression.args) analyzeExpression(child, state);
}

function analyzePattern(pattern: Pattern, state: AnalysisState): void {
  if (pattern.type === 'query') {
    state.metrics.subqueries += 1;
    analyzeQueryExpressions(pattern, state);
    analyzePattern(pattern.where, state);
    return;
  }
  switch (pattern.subType) {
    case 'bgp':
      state.metrics.triples += pattern.triples.length;
      for (const triple of pattern.triples) {
        if (triple.type !== 'triple') continue;
        if (variableName(triple.predicate)) state.metrics.variablePredicates += 1;
        analyzePath(triple.predicate, state);
      }
      return;
    case 'values':
      state.metrics.valuesRows += pattern.values.length;
      return;
    case 'optional':
      state.metrics.optionalPatterns += 1;
      break;
    case 'union':
      state.metrics.unionBranches += pattern.patterns.length;
      break;
    case 'filter':
      state.metrics.filters += 1;
      analyzeExpression(pattern.expression, state);
      return;
    case 'graph': {
      state.metrics.graphPatterns += 1;
      const graphVariable = variableName(pattern.name);
      if (graphVariable === null) {
        state.violations.push('explicit GRAPH identifiers are not allowed');
      } else if (state.valuesBoundVariables.has(graphVariable)) {
        state.violations.push('GRAPH variables must not be bound to explicit identifiers');
      }
      break;
    }
    case 'service':
      state.violations.push('SERVICE federation is not allowed');
      break;
    case 'bind':
      analyzeExpression(pattern.expression, state);
      return;
  }
  if ('patterns' in pattern) {
    for (const child of pattern.patterns) analyzePattern(child, state);
  }
}

function isGroupBind(
  grouping: Expression | SolutionModifierGroupBind,
): grouping is SolutionModifierGroupBind {
  return 'variable' in grouping;
}

function analyzeQueryExpressions(ast: QuerySelect, state: AnalysisState): void {
  for (const variable of ast.variables) {
    if (variable.type === 'pattern') analyzeExpression(variable.expression, state);
  }
  for (const grouping of ast.solutionModifiers.group?.groupings ?? []) {
    analyzeExpression(isGroupBind(grouping) ? grouping.value : grouping, state);
  }
  for (const ordering of ast.solutionModifiers.order?.orderDefs ?? []) {
    analyzeExpression(ordering.expression, state);
  }
  for (const expression of ast.solutionModifiers.having?.having ?? []) {
    analyzeExpression(expression, state);
  }
}

/** Adapt the parser AST once into the small, typed shape consumed by policy rules. */
function analyzeSemanticQueryAst(ast: AllowedQuery): SemanticQueryAnalysis {
  const modifiers = ast.solutionModifiers;
  const metrics: SemanticQueryMetrics = {
    triples: 0,
    constructTriples: ast.subType === 'construct' ? ast.template.triples.length : 0,
    optionalPatterns: 0,
    unionBranches: 0,
    filters: 0,
    graphPatterns: 0,
    propertyPaths: 0,
    variablePredicates: 0,
    subqueries: 0,
    valuesRows: 0,
    aggregates: 0,
    orderConditions: modifiers.order?.orderDefs.length ?? 0,
    groupConditions: modifiers.group?.groupings.length ?? 0,
    distinct: ast.subType === 'select' && ast.distinct === true ? 1 : 0,
  };
  const valuesBoundVariables = new Set<string>();
  const violations: string[] = [];
  const state: AnalysisState = { metrics, violations, valuesBoundVariables };
  if (ast.values) collectValueBindings(ast.values, valuesBoundVariables);
  collectValueBindings(ast.where, valuesBoundVariables);
  if (ast.subType === 'select') analyzeQueryExpressions(ast, state);
  if (ast.values) analyzePattern(ast.values, state);
  analyzePattern(ast.where, state);
  validatePatternList(ast.where.patterns, new Set(), violations);
  return { metrics, violations };
}

/** Parse and statically bound one agent-authored, read-only SPARQL 1.1 query. */
export function enforceSemanticQueryPolicy(
  sparql: string,
  maxQueryBytes: number,
): SemanticQueryPolicyResult {
  if (!sparql.trim() || Buffer.byteLength(sparql, 'utf8') > maxQueryBytes) {
    policyError(413, 'query_too_large', 'SPARQL query exceeds the configured size limit', {
      maxQueryBytes,
      suggestions: [
        'Submit a smaller query or split the exploration into several focused queries.',
      ],
    });
  }

  let ast: SparqlQuery;
  try {
    ast = parser.parse(sparql);
  } catch {
    policyError(400, 'invalid_sparql', 'query is not valid SPARQL 1.1', {
      suggestions: [
        'Check prefixes, braces, variables, and string escaping.',
        `Use LIMIT ${SEMANTIC_QUERY_DEFAULT_LIMIT} for SELECT or CONSTRUCT queries.`,
      ],
    });
  }
  if (ast.type !== 'query') {
    unsafe('only read-only SPARQL queries are allowed', [
      'Use SELECT, ASK, or CONSTRUCT. INSERT, DELETE, LOAD, CLEAR, and other updates are blocked.',
    ]);
  }
  if (ast.subType !== 'select' && ast.subType !== 'ask' && ast.subType !== 'construct') {
    unsafe('this SPARQL query form is not allowed', [
      'Use SELECT for facts, ASK for existence checks, or a bounded CONSTRUCT for a small subgraph.',
    ]);
  }
  const queryType = ast.subType;
  const datasets = ast.datasets.clauses;
  if (datasets.length > 0) {
    unsafe('FROM and FROM NAMED clauses are not allowed', [
      'Remove dataset clauses; the relay selects the current channel Context Graph server-side.',
      'Use GRAPH ?g inside the query when provenance graph identifiers are needed.',
    ]);
  }

  const limit = queryLimit(ast);
  const offset = queryOffset(ast);
  if (queryType !== 'ask' && limit === null) {
    policyError(422, 'query_too_expensive', 'SELECT and CONSTRUCT queries require LIMIT', {
      score: null,
      budget: SEMANTIC_QUERY_COST_BUDGET,
      suggestions: [
        `Add LIMIT ${SEMANTIC_QUERY_DEFAULT_LIMIT} (maximum ${SEMANTIC_QUERY_MAX_LIMIT}).`,
      ],
    });
  }
  if (
    limit !== null &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_QUERY_MAX_LIMIT)
  ) {
    policyError(422, 'query_too_expensive', 'query LIMIT is outside the allowed range', {
      limit,
      maxLimit: SEMANTIC_QUERY_MAX_LIMIT,
      suggestions: [`Use a LIMIT between 1 and ${SEMANTIC_QUERY_MAX_LIMIT}.`],
    });
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > SEMANTIC_QUERY_MAX_LIMIT) {
    policyError(422, 'query_too_expensive', 'query OFFSET is outside the allowed range', {
      offset,
      maxOffset: SEMANTIC_QUERY_MAX_LIMIT,
      suggestions: [
        'Use keyset-style pagination anchored on the last known entity instead of a large OFFSET.',
      ],
    });
  }

  const { metrics, violations } = analyzeSemanticQueryAst(ast);

  if (violations.length > 0) {
    unsafe(violations[0]!, [
      'Use exact entity or predicate IRIs, or bind variables with a small VALUES clause.',
      'Remove SERVICE, explicit GRAPH identifiers, and unbounded *, +, or ! property paths.',
      'Split broad discovery into a small selective query followed by focused queries.',
    ]);
  }
  if (
    metrics.triples + metrics.constructTriples > MAX_TRIPLES ||
    metrics.optionalPatterns > MAX_OPTIONALS ||
    metrics.unionBranches > MAX_UNION_BRANCHES ||
    metrics.subqueries > MAX_SUBQUERIES ||
    metrics.valuesRows > MAX_VALUES_ROWS ||
    metrics.graphPatterns > MAX_GRAPH_PATTERNS
  ) {
    policyError(422, 'query_too_expensive', 'query exceeds a structural cost limit', {
      budget: SEMANTIC_QUERY_COST_BUDGET,
      metrics,
      limits: {
        triples: MAX_TRIPLES,
        optionalPatterns: MAX_OPTIONALS,
        unionBranches: MAX_UNION_BRANCHES,
        subqueries: MAX_SUBQUERIES,
        valuesRows: MAX_VALUES_ROWS,
        graphPatterns: MAX_GRAPH_PATTERNS,
      },
      suggestions: [
        'Query one entity, repository, component, or decision at a time.',
        'Use VALUES to anchor known URIs and remove optional fields you do not need yet.',
      ],
    });
  }

  if (queryType === 'construct') {
    const templateTriples = metrics.constructTriples;
    const maximumQuads = templateTriples * (limit ?? 0);
    if (templateTriples < 1 || maximumQuads > SEMANTIC_QUERY_MAX_QUADS) {
      policyError(422, 'query_too_expensive', 'CONSTRUCT result may exceed the allowed size', {
        templateTriples,
        limit,
        maximumQuads,
        maxQuads: SEMANTIC_QUERY_MAX_QUADS,
        suggestions: [
          'Reduce LIMIT or construct fewer triples per matched solution.',
          'Use SELECT to discover a small set of entities, then run a focused CONSTRUCT query.',
        ],
      });
    }
  }

  const score =
    2 +
    metrics.triples * 2 +
    metrics.constructTriples * 2 +
    metrics.optionalPatterns * 3 +
    metrics.unionBranches * 4 +
    metrics.subqueries * 8 +
    metrics.filters +
    metrics.graphPatterns +
    metrics.propertyPaths * 4 +
    metrics.variablePredicates * 6 +
    metrics.aggregates * 36 +
    metrics.orderConditions * 12 +
    metrics.groupConditions * 20 +
    metrics.distinct * 3 +
    (queryType === 'construct' ? 4 : 0);
  if (score > SEMANTIC_QUERY_COST_BUDGET) {
    policyError(422, 'query_too_expensive', 'estimated query cost exceeds the budget', {
      score,
      budget: SEMANTIC_QUERY_COST_BUDGET,
      metrics,
      suggestions: [
        'Replace variable predicates with exact predicate IRIs.',
        'Remove optional or union branches and fetch those details in a follow-up query.',
        'Fetch a bounded row set and sort, group, or aggregate it in the agent process.',
        `Reduce the result to LIMIT ${SEMANTIC_QUERY_DEFAULT_LIMIT} and bind known entities with VALUES.`,
      ],
    });
  }
  return { queryType, limit, offset, score, budget: SEMANTIC_QUERY_COST_BUDGET, metrics };
}
