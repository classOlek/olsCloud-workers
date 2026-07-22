/**
 * DIAGNOSTIC: probe the Supabase leagues endpoint (read-only).
 *
 * Resolves the Supabase target exactly like leagues/src/refresh.ts
 * (SUPABASE_URL or SUPABASE_PROJECT_REF) and reads the public.leagues table
 * over PostgREST using the service_role key. service_role bypasses RLS, so this
 * is the exact call a GitHub Action would make server-side — no table GRANT and
 * no public-read policy required, and the endpoint stays closed to the anon key.
 *
 * The point of the probe is to confirm, before wiring any workflow to it, that
 * (a) the endpoint answers with the service_role secret and (b) what it returns
 * for "current" leagues. Purely read-only: it never mutates, so it needs no
 * --apply flag.
 *
 * Usage (via ClaudeDiagnostics):
 *   script = scripts/diagnostics/probe-leagues.ts
 *
 * Env (injected by the workflow):
 *   SUPABASE_URL or SUPABASE_PROJECT_REF   — the project target (public, a var)
 *   SUPABASE_SERVICE_ROLE_KEY              — server-side key, bypasses RLS (secret)
 */

function resolveSupabaseUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.SUPABASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const ref = env.SUPABASE_PROJECT_REF?.trim();
  if (ref) return `https://${ref}.supabase.co`;
  throw new Error('Missing Supabase target: set SUPABASE_URL or SUPABASE_PROJECT_REF.');
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

async function main(): Promise<void> {
  const baseUrl = resolveSupabaseUrl(process.env);
  const key = required(process.env, 'SUPABASE_SERVICE_ROLE_KEY');
  const select = 'realm,id,name,category_id,category_current,start_at,end_at,cached_at';
  const endpoint = `${baseUrl}/rest/v1/leagues?select=${select}&order=cached_at.desc`;

  console.log(`GET ${endpoint}`);
  const res = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  console.log(`HTTP ${res.status} ${res.statusText}`);

  const body = await res.text();
  if (!res.ok) {
    console.error(`Endpoint returned an error body:\n${body}`);
    process.exitCode = 1;
    return;
  }

  const rows = JSON.parse(body) as Array<Record<string, unknown>>;
  console.log(`\nRows returned: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  - id=${String(r.id).padEnd(24)} realm=${r.realm} category=${r.category_id} ` +
        `current=${r.category_current} start=${r.start_at ?? '-'} end=${r.end_at ?? '-'}`,
    );
  }

  const current = rows.filter((r) => r.category_current === true);
  console.log(`\ncategory_current === true: ${current.length} row(s)`);
  if (current.length > 0) {
    console.log(`  current ids: ${JSON.stringify(current.map((r) => String(r.id)))}`);
  }
  console.log(`all league ids: ${JSON.stringify(rows.map((r) => String(r.id)))}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
