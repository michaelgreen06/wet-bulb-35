# Local integration cleanup

Renderer and binding Wrangler integration tests use `tests/helpers/detached-process-registry.mjs`. It registers only process groups it created, terminates them on normal test cleanup, `node:test` abort, catchable `SIGINT`/`SIGTERM`/`SIGHUP`, and best-effort process exit. Local HTTP fetches have a 2-second timeout.

`SIGKILL` cannot be intercepted. The subprocess regression verifies the shell-timeout-relevant `SIGTERM` path: the owner relays SIGTERM only after its registered detached group has exited.

Run that regression with `npm run test:detached-process-registry`.

Remote parity evidence is historical: this branch's undeployed changes have not been rerun against a remote staging deployment.

The committed evidence JSON predates this local-only change and is not evidence of remote parity for it.
