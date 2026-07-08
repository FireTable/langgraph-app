// ponytail: command-line quick start. Bash block + a footnote
// pointing at the same skill file the Agent tab pulls from —
// the two tabs cover the human-typed and the agent-run paths
// to the same outcome.

import type { FC } from "react";

import { CodeBlock } from "@/components/landing/code-block";

const QUICKSTART = `# 1. Clone & configure
git clone https://github.com/FireTable/langgraph-app
cd langgraph-app
cp .env.example .env
# fill in OPENAI_API_KEY, BETTER_AUTH_SECRET, DATABASE_URL

# 2. Start Postgres + apply migrations
docker compose up -d postgres
pnpm db:migrate

# 3. Run dev (frontend on :3000, graph on :2024)
pnpm dev`;

export const CommandTab: FC = () => (
  <div className="border-border/60 bg-card text-card-foreground overflow-hidden rounded-2xl border">
    <div className="border-border/60 flex items-center justify-between border-b px-4 py-2.5">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        Quick start
      </span>
      <span className="text-muted-foreground text-xs">bash</span>
    </div>
    <div className="p-4">
      <CodeBlock code={QUICKSTART} />
      <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
        For first-time VPS deploy, daily CD updates, rollback, and backup, switch to the{" "}
        <span className="text-foreground/90 font-medium">Agent</span> tab — the same steps an agent
        runs against{" "}
        <code className="bg-muted/60 rounded px-1 py-0.5 font-mono text-[10px]">
          /skills/langgraph-app-maintain.md
        </code>
        .
      </p>
    </div>
  </div>
);
