// Ponytail: invoked by scripts/db-snapshot.sh to surface .env.local vars
// as `export K=V` lines for the calling bash shell. @next/env is CJS so
// we go through a default import and destructure.
import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());
const KEY =
  /^(DATABASE_URL|DATABASE_URL_TEST|R2_|OPENAI_|LANGCHAIN_|LANGGRAPH_|DENO_|ALCHEMY_|JINA_|BETTER_AUTH_|GOOGLE_|GITHUB_|OBSERVABILITY_|POSTGRES_|NODE_ENV)/;
for (const [k, v] of Object.entries(process.env)) {
  if (KEY.test(k)) {
    const safe = String(v).replace(/'/g, "'\\''");
    process.stdout.write(`export ${k}='${safe}'\n`);
  }
}
