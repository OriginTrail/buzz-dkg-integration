# Existing DKG Core + Buzz Relay MVP

This profile adds a Buzz Relay and the Buzz-DKG integration beside an already
running DKG v10 Core. It does not start, stop, reconfigure, or expose the Core.
The integration reaches the Core's loopback API using host networking and reads
its bearer token from a read-only bind mount.

Safety defaults:

- Verifiable Memory publication is disabled and the daily publish budget is zero.
- The relay listens only on `127.0.0.1:9440`; TLS must terminate separately.
- Docker logs are capped at three 10 MB files per service.
- Bootstrap creates one channel, one private off-chain Context Graph, and one
  service bot membership. It also publishes the managed `DKG Memory` / `dkg`
  bot profile needed for `@dkg distill` mention autocomplete. It is convergent
  on rerun.

The intended lifecycle is:

```bash
docker compose --env-file /path/to/runtime/.env -f deploy/existing-core/compose.yml \
  up -d postgres redis minio minio-init relay

# Expose 127.0.0.1:9440 as the exact HTTPS/WSS origin configured in .env.

docker compose --env-file /path/to/runtime/.env -f deploy/existing-core/compose.yml \
  build daemon
docker compose --profile tools --env-file /path/to/runtime/.env \
  -f deploy/existing-core/compose.yml run --rm bootstrap
docker compose --env-file /path/to/runtime/.env -f deploy/existing-core/compose.yml \
  up -d daemon
docker compose --profile tools --env-file /path/to/runtime/.env \
  -f deploy/existing-core/compose.yml run --rm smoke
```

The configured HTTPS/WSS origin is significant: Buzz derives the community
boundary from the request host. Bootstrap, the integration daemon, and clients
must all use the same external origin rather than the relay's loopback address.

## Operations and rollback

```bash
# Health and logs
docker compose --env-file /path/to/runtime/.env -f deploy/existing-core/compose.yml ps
docker compose --env-file /path/to/runtime/.env -f deploy/existing-core/compose.yml \
  logs -f relay daemon

# Stop only this stack. Named volumes and bootstrap state are retained.
docker compose --env-file /path/to/runtime/.env -f deploy/existing-core/compose.yml down
```

If Tailscale Serve was configured with the documented port-8443 command, an
administrator can remove only that endpoint while preserving an existing 443
route:

```bash
sudo tailscale serve --https=8443 off
```

Do not use `tailscale serve reset` on a host that serves the Core on another
port; reset removes the complete Serve configuration.
