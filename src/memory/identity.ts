/** Canonicalize a globally asserted HTTPS/URN identity without using its label. */
export function canonicalExternalIdentityUri(value: string): string {
  if (value.startsWith('urn:')) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('must be a valid HTTPS or URN identifier');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('must be an HTTPS URL without embedded credentials');
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '');
  url.searchParams.sort();
  return url.toString();
}

/** Canonical repository URL used by code identities and repository-scoped queries. */
export function canonicalRepositoryIdentityUrl(value: string): string {
  const canonical = canonicalExternalIdentityUri(value);
  if (canonical.startsWith('urn:')) throw new Error('must be a canonical HTTPS repository URL');
  const url = new URL(canonical);
  if (url.search || url.hash) throw new Error('must not contain a query or fragment');
  let path = url.pathname.replace(/\/+$/u, '').replace(/\.git$/iu, '');
  if (!path || path === '/') throw new Error('must identify a repository path');
  if (url.hostname === 'github.com') {
    const segments = path.split('/').filter(Boolean);
    if (segments.length !== 2) throw new Error('must identify one GitHub owner/repository');
    path = `/${segments.map((segment) => segment.toLowerCase()).join('/')}`;
  }
  url.pathname = path;
  return url.toString();
}
