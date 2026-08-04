export interface ChannelBindingValue {
  channelId: string;
  contextGraphId: string;
  promoters: string[];
}

export function parseTokenFile(raw: string): string;
export function normalizePublicKey(raw: unknown, label: string): string;
export function parseBindings(raw: string, options?: { strict?: boolean }): ChannelBindingValue[];
