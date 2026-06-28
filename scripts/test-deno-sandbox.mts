// ponytail: one-off smoke test for @deno/sandbox auth. Run with:
//   node --env-file=.env.local --import tsx scripts/test-deno-sandbox.mts
// Delete after we know the env vars are wired correctly.
import { Sandbox } from "@deno/sandbox";

const token = process.env.DENO_DEPLOY_TOKEN;
const org = process.env.DENO_DEPLOY_ORG;
console.log("token:", token ? `${token.slice(0, 6)}…(${token.length} chars)` : "MISSING");
console.log("org  :", org ? `${org.slice(0, 6)}…(${org.length} chars)` : "MISSING");

try {
  const sandbox = await Sandbox.create({
    token,
    ...(org ? { org } : {}),
    timeout: "30s",
  });
  const result = await sandbox.deno.eval("1 + 1");
  console.log("OK  :", result);
  await sandbox.close();
} catch (e) {
  console.log("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
}
