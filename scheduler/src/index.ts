/**
 * The collector's scheduler — a Cloudflare Worker cron that dispatches the
 * GitHub workflows, replacing GitHub's unreliable `schedule` trigger (which
 * silently drops fires under load; workflow_dispatch deterministically creates
 * a run).
 *
 * Two ticks (wrangler.toml [triggers], matched by cron expression here):
 *
 *   ROSTER tick (:00/:30) — dispatch build-roster, ALWAYS. The roster capture
 *     is the one step that must never be skipped (a character that enters and
 *     leaves the ladder between captures is missed forever). build-roster then
 *     dispatches new-snapshot itself when the snapshot state is idle.
 *
 *   COLLECT tick (every 10 min, offset off :00/:30) — dispatch the collect
 *     workflow (snapshot.yml), but SKIP the tick while a build-roster or
 *     new-snapshot run is queued/in progress. GitHub concurrency groups keep
 *     one running + one pending run and the NEWEST pending wins, so a collect
 *     dispatch racing a queued new-snapshot run would cancel it — priority
 *     (roster & new-snapshot before collect) must be enforced here, at the
 *     dispatcher, because GitHub Actions has no priority concept. A skipped
 *     tick costs nothing: the next one is minutes away and all queue state
 *     lives in R2.
 *
 * Failures throw after retries, which Cloudflare surfaces in the Worker's
 * logs/metrics (`npx wrangler tail` for live logs). The workflows keep their
 * own degraded-mode backstop crons, so a broken scheduler degrades cadence
 * instead of stopping the pipeline.
 */

export interface Env {
  /** Fine-grained PAT, Actions read+write on GITHUB_REPO (wrangler secret). */
  GITHUB_TOKEN: string;
  /** owner/repo the workflows live in (wrangler.toml [vars]). */
  GITHUB_REPO: string;
  /** Branch to dispatch workflows on (wrangler.toml [vars]). */
  GIT_REF: string;
}

/** Must match the FIRST cron expression in wrangler.toml [triggers]. */
const ROSTER_CRON = '0,30 * * * *';

const ROSTER_WORKFLOW = 'build-roster.yml';
const NEW_SNAPSHOT_WORKFLOW = 'new-snapshot.yml';
const COLLECT_WORKFLOW = 'snapshot.yml';

/** Runs in these states can still be displaced or double-started — treat as busy. */
const ACTIVE_STATUSES = ['queued', 'in_progress'] as const;

const API = 'https://api.github.com';

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (event.cron === ROSTER_CRON) {
      // Hard requirement: never skip a roster tick. No pre-checks that could
      // wrongly veto it — the workflow's own concurrency group serializes any
      // rare overlap, and a roster build never conflicts with the collect chain.
      await dispatch(env, ROSTER_WORKFLOW);
      return;
    }

    // Collect tick: yield to the roster/new-snapshot chain when it is active.
    const busyWorkflow = await firstActiveOf(env, [ROSTER_WORKFLOW, NEW_SNAPSHOT_WORKFLOW]);
    if (busyWorkflow !== undefined) {
      console.log(`collect tick skipped: ${busyWorkflow} is queued/in progress`);
      return;
    }
    await dispatch(env, COLLECT_WORKFLOW);
  },
};

/** Create a workflow_dispatch run; retries transient failures (3 attempts). */
async function dispatch(env: Env, workflow: string): Promise<void> {
  await withRetries(`dispatch ${workflow}`, async () => {
    const res = await gh(env, 'POST', `/actions/workflows/${workflow}/dispatches`, {
      ref: env.GIT_REF,
    });
    // 204 No Content on success; anything else is an error worth surfacing.
    if (res.status !== 204) {
      throw new Error(`dispatch ${workflow}: HTTP ${res.status} — ${await res.text()}`);
    }
    console.log(`dispatched ${workflow} on ${env.GIT_REF}`);
  });
}

/** The first of `workflows` with a queued or in-progress run, else undefined. */
async function firstActiveOf(env: Env, workflows: string[]): Promise<string | undefined> {
  for (const workflow of workflows) {
    for (const status of ACTIVE_STATUSES) {
      const active = await withRetries(`check ${workflow} ${status}`, async () => {
        const res = await gh(
          env,
          'GET',
          `/actions/workflows/${workflow}/runs?status=${status}&per_page=1`,
        );
        if (!res.ok) {
          throw new Error(`runs ${workflow} ${status}: HTTP ${res.status} — ${await res.text()}`);
        }
        const body = (await res.json()) as { total_count: number };
        return body.total_count > 0;
      });
      if (active) return workflow;
    }
  }
  return undefined;
}

function gh(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}/repos/${env.GITHUB_REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      // GitHub rejects requests without a User-Agent. Neutral on purpose —
      // this only ever talks to the GitHub API, never to GGG.
      'user-agent': 'pou-collector-scheduler',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** 3 attempts with 2s/4s backoff; the last failure propagates (→ Worker logs). */
async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`${label}: attempt ${attempt} failed: ${String(err)}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
