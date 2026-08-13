import type {
  TrustNetworkResult,
  TrustPersonSummary,
  TrustVouchLifecycleState,
  TrustVouchStatus,
  TrustVouchSummary,
  VisibleMemoryLayer,
} from './types.ts';
import { parseTrustVouchTags } from '../memory/trust-source.ts';

type BindingRow = Record<string, unknown>;
export type TrustLayeredRow = { row: BindingRow; layer: VisibleMemoryLayer };

const VIEWS: readonly VisibleMemoryLayer[] = ['SWM', 'VM'];
const LAYER_RANK: Record<VisibleMemoryLayer, number> = { SWM: 0, VM: 1 };
const MAX_TRUST_PEOPLE = 200;
const MAX_TRUST_VOUCHES = 400;
const MAX_TRUST_SUPPORTS = 2_400;
const MAX_TRUST_LIFECYCLE = 400;
const HEX_PUBKEY = /^[0-9a-f]{64}$/iu;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/iu;
const SAFE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^<>"{}|^`\\\s]{1,999}$/u;
const NOSTR_EVENT_URI = /^urn:nostr:event:[0-9a-f]{64}$/u;
const NOSTR_PUBKEY_URI = 'urn:nostr:pubkey:';

const NOSTR = 'https://w3id.org/buzz-dkg/nostr#';
const PROV = 'http://www.w3.org/ns/prov#';
const SCHEMA = 'http://schema.org/';
const DECISIONS = 'http://dkg.io/ontology/decisions/';
const GITHUB = 'http://dkg.io/ontology/github/';
const MEMORY = 'http://dkg.io/ontology/memory/';
const SOFTWARE = 'http://dkg.io/ontology/software/';
const TASKS = 'http://dkg.io/ontology/tasks/';
const TRUST = 'http://dkg.io/ontology/trust/';

function rawTerm(value: unknown): string {
  if (value && typeof value === 'object' && 'value' in value) {
    return String((value as { value?: unknown }).value ?? '');
  }
  return String(value ?? '');
}

function bindingTerm(value: unknown): string {
  const raw = rawTerm(value);
  if (raw.startsWith('<') && raw.endsWith('>')) return raw.slice(1, -1);
  if (!raw.startsWith('"')) return raw;
  let escaped = false;
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === '"' && !escaped) {
      try {
        return JSON.parse(raw.slice(0, index + 1)) as string;
      } catch {
        return raw.slice(1, index);
      }
    }
    escaped = char === '\\' ? !escaped : false;
  }
  return raw.slice(1);
}

function term(row: BindingRow, key: string): string {
  return bindingTerm(row[key]);
}

function optionalTerm(row: BindingRow, key: string): string | null {
  return row[key] === undefined ? null : bindingTerm(row[key]);
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function count(value: unknown): number {
  const parsed = Number(bindingTerm(value));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function dateTimestamp(value: unknown): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(bindingTerm(value));
  return Number.isFinite(parsed) ? parsed / 1_000 : null;
}

function trustVouchStatus(value: string | null): TrustVouchStatus {
  return value === 'active' || value === 'revoked' || value === 'superseded' ? value : 'unknown';
}

function sourceMatchesVouch(
  row: BindingRow,
  issuer: string,
  subject: string,
  note: string | null,
): boolean {
  const source = optionalTerm(row, 'source');
  const sourceAuthor = optionalTerm(row, 'sourceAuthor');
  const sourceTags = optionalTerm(row, 'sourceTags');
  const sourceKind = optionalTerm(row, 'sourceKind');
  const sourceSig = optionalTerm(row, 'sourceSig');
  const sourceContent = optionalTerm(row, 'sourceContent');
  if (
    !source ||
    !NOSTR_EVENT_URI.test(source) ||
    sourceAuthor !== `${NOSTR_PUBKEY_URI}${issuer}` ||
    sourceKind !== '1985' ||
    sourceSig === null ||
    !HEX_SIGNATURE.test(sourceSig) ||
    !sourceTags ||
    note === null ||
    sourceContent !== note
  ) {
    return false;
  }
  try {
    const tags = JSON.parse(sourceTags) as unknown;
    const parsed = parseTrustVouchTags(tags);
    return parsed.ok && parsed.subjectPubkey === subject;
  } catch {
    return false;
  }
}

/** Discover and materialize the bounded trust snapshot for one Context Graph. */
export async function queryTrustNetwork(
  layered: (sparql: string) => Promise<TrustLayeredRow[]>,
): Promise<TrustNetworkResult> {
  const [contributionRows, vouchRows, supportRows, lifecycleRows] = await Promise.all([
    layered(
      `SELECT ?pk (COUNT(DISTINCT ?record) AS ?n) (MAX(?at) AS ?latest)
       WHERE { GRAPH ?g {
         ?memory <${MEMORY}contains> ?record .
         ?record a ?kind ; <${PROV}wasDerivedFrom> ?source .
         ?source <${PROV}wasAttributedTo> ?agent .
         VALUES ?kind {
           <${MEMORY}Claim> <${MEMORY}Question> <${DECISIONS}Decision> <${TASKS}Task>
           <${GITHUB}PullRequest> <${GITHUB}Issue> <${GITHUB}Commit> <${GITHUB}Review>
           <${SOFTWARE}Build> <${SOFTWARE}TestCase> <${SOFTWARE}TestRun>
           <${SOFTWARE}Deployment> <${SOFTWARE}Finding>
         }
         ?agent <${NOSTR}pubkeyHex> ?pk .
         OPTIONAL { ?source <${NOSTR}createdAt> ?at }
       } } GROUP BY ?pk ORDER BY DESC(?n) LIMIT ${MAX_TRUST_PEOPLE + 1}`,
    ),
    layered(
      `SELECT DISTINCT ?vouch ?issuer ?subject ?note ?status ?at ?source
        ?sourceKind ?sourceAuthor ?sourceTags ?sourceSig ?sourceContent WHERE { GRAPH ?g {
         ?vouch a <${TRUST}Vouch> ; <${TRUST}issuer> ?issuer ;
           <${TRUST}subject> ?subject ; <${TRUST}scope> "channel" .
         OPTIONAL { ?vouch <${SCHEMA}description> ?note }
         OPTIONAL { ?vouch <${TRUST}status> ?status }
         OPTIONAL {
           ?vouch <${PROV}wasDerivedFrom> ?source .
           ?source a <${NOSTR}Event> ; <${NOSTR}kind> ?sourceKind ;
             <${NOSTR}tags> ?sourceTags ; <${NOSTR}sig> ?sourceSig ; <${NOSTR}content> ?sourceContent ;
             <${PROV}wasAttributedTo> ?sourceAuthor .
           OPTIONAL { ?source <${NOSTR}createdAt> ?at }
         }
      } } ORDER BY DESC(?at) LIMIT ${MAX_TRUST_VOUCHES + 1}`,
    ),
    layered(
      `SELECT DISTINCT ?vouch ?reference ?target ?evidenceSource WHERE { GRAPH ?g {
         ?vouch <${TRUST}supportedBy> ?reference .
         ?reference <${TRUST}evidenceTarget> ?target .
         OPTIONAL { ?reference <${TRUST}evidenceSource> ?evidenceSource }
       } } LIMIT ${MAX_TRUST_SUPPORTS + 1}`,
    ),
    layered(
      `SELECT DISTINCT ?action ?issuer ?subject ?status ?target ?replacement ?at ?source
       WHERE { GRAPH ?g {
         ?action a <${TRUST}VouchLifecycle> ; <${TRUST}scope> "channel" ;
           <${TRUST}targetVouch> ?target ; <${TRUST}issuer> ?issuer ;
           <${TRUST}subject> ?subject ; <${TRUST}status> ?status .
         OPTIONAL { ?action <${TRUST}replacementVouch> ?replacement }
         OPTIONAL {
           ?action <${PROV}wasDerivedFrom> ?source .
           OPTIONAL { ?source <${NOSTR}createdAt> ?at }
         }
       } } ORDER BY DESC(?at) LIMIT ${MAX_TRUST_LIFECYCLE + 1}`,
    ),
  ]);

  const queryHitBound = (rows: TrustLayeredRow[], maximum: number): boolean =>
    VIEWS.some((layer) => rows.filter((candidate) => candidate.layer === layer).length > maximum);
  let partial =
    queryHitBound(contributionRows, MAX_TRUST_PEOPLE) ||
    queryHitBound(vouchRows, MAX_TRUST_VOUCHES) ||
    queryHitBound(supportRows, MAX_TRUST_SUPPORTS) ||
    queryHitBound(lifecycleRows, MAX_TRUST_LIFECYCLE);
  const people = new Map<string, TrustPersonSummary>();
  const upsertPerson = (pubkey: string, layer: VisibleMemoryLayer): TrustPersonSummary => {
    const current = people.get(pubkey);
    if (current) {
      if (LAYER_RANK[layer] > LAYER_RANK[current.layer]) current.layer = layer;
      return current;
    }
    const created: TrustPersonSummary = {
      pubkey,
      contributions: 0,
      contributionLayer: null,
      latest: null,
      vouchesReceived: 0,
      vouchesGiven: 0,
      layer,
    };
    people.set(pubkey, created);
    return created;
  };
  for (const { row, layer } of contributionRows) {
    const pubkey = term(row, 'pk').toLowerCase();
    if (!HEX_PUBKEY.test(pubkey)) continue;
    const person = upsertPerson(pubkey, layer);
    person.contributions = Math.max(person.contributions, count(row.n));
    if (
      person.contributionLayer === null ||
      LAYER_RANK[layer] > LAYER_RANK[person.contributionLayer]
    ) {
      person.contributionLayer = layer;
    }
    person.latest = Math.max(person.latest ?? 0, dateTimestamp(row.latest) ?? 0) || null;
  }

  const pubkeyFromEntity = (value: string): string | null => {
    if (!value.startsWith(NOSTR_PUBKEY_URI)) return null;
    const pubkey = value.slice(NOSTR_PUBKEY_URI.length).toLowerCase();
    return HEX_PUBKEY.test(pubkey) ? pubkey : null;
  };
  const vouchesByUri = new Map<string, TrustVouchSummary>();
  for (const { row, layer } of vouchRows) {
    const uri = bounded(term(row, 'vouch'), 1_000);
    const issuer = pubkeyFromEntity(term(row, 'issuer'));
    const subject = pubkeyFromEntity(term(row, 'subject'));
    if (!uri || !issuer || !subject || issuer === subject) continue;
    const source = optionalTerm(row, 'source');
    const note = optionalTerm(row, 'note');
    const candidate: TrustVouchSummary = {
      uri,
      issuer,
      subject,
      note: note ? bounded(note, 1_000) : null,
      status: trustVouchStatus(optionalTerm(row, 'status')),
      at: dateTimestamp(row.at),
      sourceEvent: sourceMatchesVouch(row, issuer, subject, note) ? bounded(source!, 1_000) : null,
      evidence: [],
      evidenceSources: [],
      lifecycleEvent: null,
      replacementVouch: null,
      layer,
    };
    const current = vouchesByUri.get(uri);
    if (
      !current ||
      LAYER_RANK[layer] > LAYER_RANK[current.layer] ||
      (layer === current.layer && current.sourceEvent === null && candidate.sourceEvent !== null)
    ) {
      vouchesByUri.set(uri, candidate);
    }
  }

  for (const { row } of supportRows) {
    const vouch = vouchesByUri.get(bounded(term(row, 'vouch'), 1_000));
    const target = bounded(term(row, 'target'), 1_000);
    if (!vouch || !SAFE_IRI.test(target)) continue;
    if (!vouch.evidence.includes(target)) vouch.evidence.push(target);
    const evidenceSource = optionalTerm(row, 'evidenceSource');
    if (
      evidenceSource &&
      NOSTR_EVENT_URI.test(evidenceSource) &&
      !vouch.evidenceSources.includes(evidenceSource)
    ) {
      vouch.evidenceSources.push(evidenceSource);
    }
  }

  type LifecycleAction = TrustVouchLifecycleState & {
    issuer: string;
    subject: string;
    at: number | null;
    layer: VisibleMemoryLayer;
  };
  const lifecycleByTarget = new Map<string, LifecycleAction>();
  for (const { row, layer } of lifecycleRows) {
    const target = bounded(term(row, 'target'), 1_000);
    const targetVouch = vouchesByUri.get(target);
    const issuer = pubkeyFromEntity(term(row, 'issuer'));
    const subject = pubkeyFromEntity(term(row, 'subject'));
    const status = term(row, 'status');
    const source = optionalTerm(row, 'source')
      ? bounded(optionalTerm(row, 'source')!, 1_000)
      : null;
    const replacement = optionalTerm(row, 'replacement')
      ? bounded(optionalTerm(row, 'replacement')!, 1_000)
      : null;
    if (
      !targetVouch ||
      !issuer ||
      !subject ||
      issuer !== targetVouch.issuer ||
      subject !== targetVouch.subject ||
      !new Set(['revoked', 'superseded']).has(status) ||
      !source ||
      !NOSTR_EVENT_URI.test(source) ||
      (status === 'superseded' && (!replacement || !SAFE_IRI.test(replacement))) ||
      (status === 'revoked' && replacement)
    ) {
      continue;
    }
    const candidate: LifecycleAction =
      status === 'revoked'
        ? {
            issuer,
            subject,
            status,
            at: dateTimestamp(row.at),
            lifecycleEvent: source,
            replacementVouch: null,
            layer,
          }
        : {
            issuer,
            subject,
            status: 'superseded',
            at: dateTimestamp(row.at),
            lifecycleEvent: source,
            replacementVouch: replacement!,
            layer,
          };
    const current = lifecycleByTarget.get(target);
    if (
      !current ||
      (candidate.at ?? 0) > (current.at ?? 0) ||
      ((candidate.at ?? 0) === (current.at ?? 0) &&
        candidate.lifecycleEvent.localeCompare(current.lifecycleEvent) > 0)
    ) {
      lifecycleByTarget.set(target, candidate);
    }
  }
  for (const [target, lifecycle] of lifecycleByTarget) {
    const vouch = vouchesByUri.get(target)!;
    vouch.status = lifecycle.status;
    vouch.lifecycleEvent = lifecycle.lifecycleEvent;
    vouch.replacementVouch = lifecycle.replacementVouch;
    if (LAYER_RANK[lifecycle.layer] > LAYER_RANK[vouch.layer]) vouch.layer = lifecycle.layer;
  }
  const sortedVouches = [...vouchesByUri.values()].sort(
    (a, b) => (b.at ?? 0) - (a.at ?? 0) || a.uri.localeCompare(b.uri),
  );
  if (sortedVouches.length > MAX_TRUST_VOUCHES) partial = true;
  const vouches = sortedVouches.slice(0, MAX_TRUST_VOUCHES);
  for (const vouch of vouches) {
    if (vouch.status !== 'active') continue;
    upsertPerson(vouch.issuer, vouch.layer).vouchesGiven += 1;
    upsertPerson(vouch.subject, vouch.layer).vouchesReceived += 1;
  }
  const sortedPeople = [...people.values()].sort(
    (a, b) =>
      b.vouchesReceived - a.vouchesReceived ||
      b.contributions - a.contributions ||
      a.pubkey.localeCompare(b.pubkey),
  );
  if (sortedPeople.length > MAX_TRUST_PEOPLE) partial = true;
  return {
    completeness: partial ? 'partial' : 'complete',
    people: sortedPeople.slice(0, MAX_TRUST_PEOPLE),
    vouches,
  };
}
