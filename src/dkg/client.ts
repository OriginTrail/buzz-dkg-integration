export { DkgClient } from './http.mjs';
export type { DescriptorResponse, QueryResult } from './http.mjs';

export function bindingValue(b: { value?: string } | string | undefined): string | undefined {
  if (b === undefined) return undefined;
  return typeof b === 'string' ? b : b.value;
}
