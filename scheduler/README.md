# Scheduler (Cloudflare Worker)

The collector's real clock. GitHub's `schedule` trigger is best-effort — fires
are delayed and silently dropped under load (observed on this repo: a `*/30`
cron firing about once every 1–3 hours) — while a `workflow_dispatch` API call
deterministically creates a run. This Worker turns Cloudflare's reliable cron
into GitHub `workflow_dispatch` calls:

| Tick    | When                       | Does                                                                                          |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| roster  | `:00` and `:30`            | dispatch `build-roster.yml` — always, never skipped                                            |
| collect | `:05 :15 :25 :35 :45 :55`  | dispatch `snapshot.yml`, unless a `build-roster` / `new-snapshot` run is queued or in progress |

The collect tick's skip rule is what gives roster + new-snapshot priority:
GitHub concurrency groups keep at most one running and one pending run, and the
_newest_ pending run wins — a collect dispatch racing a queued new-snapshot run
would cancel it. GitHub has no priority concept, so priority lives here, in the
dispatcher.

The `new-snapshot` workflow is **not** dispatched from here: `build-roster.yml`
triggers it after each build when its snapshot-idle check passes (that check
needs R2 state, which the workflow already has credentials for).

The workflows keep degraded-mode backstop crons (`7,37` roster, `13,43`
collect), so if this Worker breaks the pipeline limps instead of stopping.

## Setup, step by step

Everything below is on Cloudflare's **free plan** (cron triggers included) and
uses no always-on server.

### 1. Create the GitHub token

1. GitHub → your avatar → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Name: `pou-collector-scheduler`. Expiration: pick the maximum (366 days) and
   put a reminder in your calendar — **the scheduler dies silently when the
   token expires**, leaving only the backstop crons.
3. **Repository access**: _Only select repositories_ → `pou-collector`.
4. **Permissions** → _Repository permissions_ → **Actions: Read and write**.
   Nothing else.
5. Generate and copy the token (shown once).

### 2. Deploy the Worker

Requires Node 22+ (already required by this repo). From the repo root:

```sh
cd scheduler
npx wrangler login          # opens the browser; free Cloudflare account is fine
npx wrangler deploy         # deploys the Worker with both cron triggers
npx wrangler secret put GITHUB_TOKEN   # paste the PAT from step 1
```

`wrangler deploy` prints the Worker name (`pou-collector-scheduler`) and the
registered crons. The secret survives redeploys; you only set it again when
rotating the token.

### 3. Verify it fires

- Immediate smoke test without waiting for a tick:

  ```sh
  npx wrangler dev --test-scheduled
  # in a second terminal — fire each tick by its cron expression:
  curl 'http://localhost:8787/__scheduled?cron=0%2C30+*+*+*+*'
  curl 'http://localhost:8787/__scheduled?cron=5%2C15%2C25%2C35%2C45%2C55+*+*+*+*'
  ```

  The first should create a **BUILD roster** run in the repo's Actions tab
  within seconds; the second creates an **UPDATE collect snapshot** run (or
  logs a skip if roster/new-snapshot is active).

- Live logs of the deployed Worker: `npx wrangler tail`.
- Cloudflare dashboard → Workers & Pages → `pou-collector-scheduler` →
  **Logs**/**Metrics** shows every cron invocation and any errors.
- After an hour, the repo's Actions tab should show `workflow_dispatch` runs of
  BUILD roster at :00/:30 and collect runs every 10 minutes.

### 4. Tune the collect cadence

Edit the **second** cron in `wrangler.toml` and `npx wrangler deploy`. Keep it
off `:00`/`:30` (those belong to the roster tick). Examples:

```toml
"5,15,25,35,45,55 * * * *"   # every 10 min (default)
"7,22,37,52 * * * *"         # every 15 min
"5,10,15,20,25,35,40,45,50,55 * * * *"  # every 5 min
```

Ticks that arrive while the in-collector `collectCooldownMinutes` gate is
closed are request-free no-ops, so a faster tick never increases load on GGG by
itself — it only reduces the idle gap between waves.

### 5. Token rotation

When the PAT nears expiry: generate a new one (step 1) and run
`npx wrangler secret put GITHUB_TOKEN` again. No redeploy needed.

## Failure modes

| Failure                        | Effect                                                                | Recovery                                                  |
| ------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| GitHub API down / 5xx          | tick retried 3× (2s/4s backoff), then logged as an error and dropped | next tick is ≤10 min away; backstop crons also still fire |
| PAT expired/revoked            | every dispatch fails (401) — visible in Worker logs/metrics           | rotate the secret (step 5)                                |
| Worker deleted / account issue | no dispatches at all                                                  | backstop crons keep a degraded cadence; redeploy           |
| GitHub Actions outage          | dispatches accepted but runs delayed                                  | nothing to do; queue state is in R2, runs resume          |
