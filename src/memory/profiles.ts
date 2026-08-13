import type { AgentMemoryProfileId } from '../types.ts';

export const PROFILE_IRIS: Record<AgentMemoryProfileId | 'buzz-nostr@1', string> = {
  'dkg-memory@1': 'http://dkg.io/ontology/profile/dkg-memory/1',
  'dkg-software@1': 'http://dkg.io/ontology/profile/dkg-software/1',
  'dkg-trust@1': 'http://dkg.io/ontology/profile/dkg-trust/1',
  'buzz-nostr@1': 'https://w3id.org/buzz-dkg/profile/buzz-nostr/1',
};

export const PREFIXES = {
  memory: 'http://dkg.io/ontology/memory/',
  code: 'http://dkg.io/ontology/code/',
  github: 'http://dkg.io/ontology/github/',
  decisions: 'http://dkg.io/ontology/decisions/',
  tasks: 'http://dkg.io/ontology/tasks/',
  agent: 'http://dkg.io/ontology/agent/',
  software: 'http://dkg.io/ontology/software/',
  trust: 'http://dkg.io/ontology/trust/',
  schema: 'http://schema.org/',
  prov: 'http://www.w3.org/ns/prov#',
} as const;

type Datatype = 'string' | 'integer' | 'decimal' | 'boolean' | 'dateTime' | 'anyURI';

interface ProfileDefinition {
  types: ReadonlySet<string>;
  relations: ReadonlySet<string>;
  attributes: ReadonlyMap<string, Datatype>;
}

const terms = (prefix: keyof typeof PREFIXES, names: readonly string[]) =>
  names.map((name) => `${prefix}:${name}`);

const attributes = (
  prefix: keyof typeof PREFIXES,
  definitions: Readonly<Record<string, Datatype>>,
): [string, Datatype][] =>
  Object.entries(definitions).map(([name, datatype]) => [`${prefix}:${name}`, datatype]);

export const PROFILE_DEFINITIONS: Record<AgentMemoryProfileId, ProfileDefinition> = {
  'dkg-memory@1': {
    types: new Set([
      ...terms('memory', ['Entity', 'Claim', 'Question', 'Relationship']),
      ...terms('decisions', ['Decision']),
      ...terms('tasks', ['Task']),
      ...terms('schema', ['Person', 'Organization', 'Event', 'Place', 'Project', 'CreativeWork']),
    ]),
    relations: new Set([
      ...terms('memory', ['about', 'supports', 'contradicts', 'resolves']),
      ...terms('decisions', ['affects', 'recordedIn', 'implementedBy', 'supersedes']),
      ...terms('tasks', ['assignee', 'relatedDecision', 'dependsOn', 'touches']),
      ...terms('schema', [
        'about',
        'member',
        'organizer',
        'location',
        'attendee',
        'hasPart',
        'sameAs',
      ]),
    ]),
    attributes: new Map([
      ...attributes('decisions', {
        context: 'string',
        outcome: 'string',
        consequences: 'string',
        status: 'string',
      }),
      ...attributes('tasks', { status: 'string', priority: 'string', dueDate: 'dateTime' }),
      ...attributes('schema', {
        identifier: 'string',
        dateCreated: 'dateTime',
        startDate: 'dateTime',
        endDate: 'dateTime',
        status: 'string',
      }),
    ]),
  },
  'dkg-software@1': {
    types: new Set([
      ...terms('code', [
        'Component',
        'Package',
        'File',
        'Function',
        'Class',
        'Interface',
        'TypeAlias',
        'Enum',
      ]),
      ...terms('github', ['Repository', 'PullRequest', 'Issue', 'Commit', 'Review', 'User']),
      ...terms('software', ['Build', 'TestCase', 'TestRun', 'Deployment', 'Finding']),
    ]),
    relations: new Set([
      ...terms('code', [
        'package',
        'contains',
        'definedIn',
        'imports',
        'exports',
        'extends',
        'implements',
        'calls',
        'dependsOn',
      ]),
      ...terms('github', [
        'authoredBy',
        'reviewedBy',
        'affects',
        'inRepo',
        'containsCommit',
        'parentCommit',
        'closes',
      ]),
      ...terms('software', [
        'repository',
        'atRevision',
        'tests',
        'executedTest',
        'supports',
        'deployedCommit',
        'spdxElement',
      ]),
    ]),
    attributes: new Map([
      ...attributes('code', {
        path: 'string',
        language: 'string',
        qualifiedName: 'string',
        startLine: 'integer',
        endLine: 'integer',
      }),
      ...attributes('github', {
        number: 'integer',
        state: 'string',
        sha: 'string',
        url: 'anyURI',
        mergedAt: 'dateTime',
      }),
      ...attributes('software', { result: 'string', environment: 'string' }),
    ]),
  },
  'dkg-trust@1': {
    types: new Set([...terms('trust', ['Vouch', 'EvidenceReference', 'VouchLifecycle'])]),
    relations: new Set([...terms('trust', ['issuer', 'subject', 'supportedBy'])]),
    attributes: new Map([
      ...attributes('trust', {
        status: 'string',
        scope: 'string',
        evidenceTarget: 'anyURI',
        evidenceSource: 'anyURI',
        targetVouch: 'anyURI',
        replacementVouch: 'anyURI',
      }),
    ]),
  },
};

export function expandProfileTerm(term: string): string | null {
  const separator = term.indexOf(':');
  if (separator < 1) return null;
  const prefix = term.slice(0, separator) as keyof typeof PREFIXES;
  const localName = term.slice(separator + 1);
  const namespace = PREFIXES[prefix];
  return namespace && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(localName)
    ? `${namespace}${localName}`
    : null;
}

export function profileAllowsType(
  profiles: readonly AgentMemoryProfileId[],
  term: string,
): boolean {
  return profiles.some((profile) => PROFILE_DEFINITIONS[profile].types.has(term));
}

export function profileAllowsRelation(
  profiles: readonly AgentMemoryProfileId[],
  term: string,
): boolean {
  return profiles.some((profile) => PROFILE_DEFINITIONS[profile].relations.has(term));
}

export function profileAttributeDatatype(
  profiles: readonly AgentMemoryProfileId[],
  term: string,
): Datatype | null {
  for (const profile of profiles) {
    const datatype = PROFILE_DEFINITIONS[profile].attributes.get(term);
    if (datatype) return datatype;
  }
  return null;
}
