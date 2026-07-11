// ponytail: one CapturingHandler instance per process, shared across
// every graph registered in langgraph.json (currently `agent` and
// `background_agent`). The .withConfig({ callbacks: [handler] })
// pattern applies the same singleton to each compiled Pregel, so
// spans from both chat and background invocations land in the same
// in-memory Map and the same write path.
//
// Lifted out of backend/observability/ when the background_agent
// graph registered: the singleton now has TWO consumers (chat +
// background), so it stopped being an "observability" implementation
// detail and became a backend-wide callback wiring. The observability/
// folder keeps the CapturingHandler class itself; this file owns the
// "one instance" wiring that both graphs reach for.
//
// ponytail: CapturingHandler calls `bulkInsertSpans` directly (imported
// from `@/lib/observability/queries`) instead of accepting it as a
// constructor option. The single consumer is this file; inlining
// avoids the indirection-without-extra-flexibility tax.
//
// CreditTrackingHandler follows the same singleton pattern (issue #15):
// one instance shared across all compiled graphs so the in-memory
// `runMeta` map tracks every concurrent LLM call regardless of which
// graph it lives in. Each graph's compile() imports this constant and
// spreads it into the `callbacks:` array — see backend/agent.ts.
//
// Concurrent threads cross-mixing in the buffer is a known ceiling
// (issue: thread A's span write can clobber thread B's mid-flight
// state). Acceptable for single-dev-session use; revisit when we
// move to prod checkpointing.
import { CapturingHandler } from "@/lib/observability/callback";
import { CreditTrackingHandler } from "@/lib/credit/callback";

export const capturingHandler = new CapturingHandler();
export const creditTrackingHandler = new CreditTrackingHandler();
