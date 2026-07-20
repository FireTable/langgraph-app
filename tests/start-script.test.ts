// cspell:ignore LANGSERVE
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("container startup", () => {
  it("always derives LANGSERVE_GRAPHS from langgraph.json", () => {
    const binDir = mkdtempSync(join(tmpdir(), "langgraph-start-"));
    tempDirs.push(binDir);

    const pnpm = join(binDir, "pnpm");
    writeFileSync(pnpm, '#!/bin/sh\nprintf "\\n%s\\n" "$LANGSERVE_GRAPHS"\n');
    chmodSync(pnpm, 0o755);

    const output = execFileSync("sh", ["scripts/start.sh"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "",
        LANGSERVE_GRAPHS: '{"stale":"./stale.ts:graph"}',
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        ROLE: "frontend",
      },
    });
    const actual = JSON.parse(output.trim().split("\n").at(-1)!);
    const expected = JSON.parse(readFileSync(join(projectRoot, "langgraph.json"), "utf8")).graphs;

    expect(actual).toEqual(expected);
    expect(readFileSync(join(projectRoot, "Dockerfile"), "utf8")).not.toMatch(
      /^ENV LANGSERVE_GRAPHS=/m,
    );
  });
});
