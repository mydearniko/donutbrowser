# Donut Sync

Donut Sync is the self-hosted profile synchronization service for Donut
Browser. Its default backend is an atomic local object store under `DATA_DIR`;
MinIO, S3, and external databases are not required.

## Start with Docker Compose

From this directory:

```bash
cp .env.example .env
openssl rand -hex 32
# Put the generated value in .env as SYNC_TOKEN, then:
docker compose up -d --build
```

The only persistent state is mounted at `./data`. Back up that directory while
the container is stopped, or use a filesystem snapshot tool that provides a
consistent point-in-time snapshot.

Verify both the process and storage:

```bash
curl http://127.0.0.1:12342/health
curl http://127.0.0.1:12342/readyz
```

Then open **Account → Self-Hosted** in Donut Browser and enter the server URL
and the same `SYNC_TOKEN` value.

## Production exposure

Keep `DONUT_SYNC_BIND=127.0.0.1` and put Caddy, Nginx, or another reverse proxy
with TLS in front of the service. Set `PUBLIC_URL` if the proxy does not pass
`X-Forwarded-Proto` and `X-Forwarded-Host` correctly. The bearer token grants
full access to all synchronized data, so never expose it over plaintext HTTP.

## Storage layout and consistency

- Object bodies are stored below `DATA_DIR/objects`.
- Metadata is stored separately below `DATA_DIR/.metadata`.
- Uploads stream to `DATA_DIR/.tmp`, are fsynced, and are atomically renamed.
- Realtime events are emitted only after the durable rename completes.
- Profile file uploads are coalesced: peers react to the completed manifest,
  not every intermediate file.
- Donut verifies each file hash and atomically replaces downloads before the
  manifest is committed. A last-synced baseline makes handoff direction immune
  to clock skew between devices.
- Renewable profile leases are persisted in `DATA_DIR/.profile-locks.json`.
  Donut refreshes them every 10 seconds; an uncleanly stopped client releases
  automatically after the 45-second lease expires.

Donut reconciles a profile after acquiring its lease and before Chromium
opens it. On close, the lease stays held until the final manifest is durable.
Using one profile concurrently remains intentionally unsupported.

The server remains single-writer per mounted data directory. Run one container
against a given `data` directory; use Donut's profile locks to prevent people
from opening the same browser profile concurrently.

## Optional legacy S3 backend

Set `STORAGE_DRIVER=s3` and provide `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, and the usual optional S3 settings. This
compatibility mode remains available, but the Compose deployment intentionally
uses the faster local backend.
