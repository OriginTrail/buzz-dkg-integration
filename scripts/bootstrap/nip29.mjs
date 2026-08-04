function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function hasMarker(event, name) {
  return event.tags.some((tag) => tag[0] === name);
}

/** Normalize relay-signed kind 39000 metadata without inventing missing shape. */
export function channelFromMetadataEvent(event) {
  const explicitVisibility = tagValue(event, 'visibility');
  const visibility = hasMarker(event, 'private')
    ? 'private'
    : explicitVisibility === 'private'
      ? 'private'
      : 'open';
  const archived = tagValue(event, 'archived');
  return {
    id: tagValue(event, 'd'),
    name: tagValue(event, 'name'),
    visibility,
    channelType: tagValue(event, 't') || tagValue(event, 'channel_type'),
    archived: ['true', '1'].includes(String(archived).toLowerCase()),
  };
}

/** NIP-29 p tags are ["p", pubkey, relay-hint, role]. */
export function membershipRole(tag) {
  return tag?.[0] === 'p' ? tag[3] : undefined;
}
