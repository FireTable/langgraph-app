// ponytail: one CapturingHandler instance per process, shared across
// every graph registered in langgraph.json (currently `agent` and
// `background_agent`). The .withConfig({ callbacks: [handler] })
// pattern applies the same singleton to each compiled Pregel, so
// spans from both chat and background invocations land in the same
// in-memory Map and the same `bulkInsertSpans` write path.
//
// Lifted out of backend/observability/ when the background_agent
// graph registered: the singleton now has TWO consumers (chat +
// background), so it stopped being an "observability" implementation
// detail and became a backend-wide callback wiring. The observability/
// folder keeps the CapturingHandler class itself; this file owns the
// "one instance + bulkInsert pipeline" wiring that both graphs reach
// for.
//
// Concurrent threads cross-mixing in the buffer is a known ceiling
// (issue: thread A's span write can clobber thread B's mid-flight
// state). Acceptable for single-dev-session use; revisit when we
// move to prod checkpointing.
import { CapturingHandler } from "@/backend/observability/callback-collector";
import { bulkInsertSpans } from "@/lib/observability/queries";

export const capturingHandler = new CapturingHandler({
  bulkInsert: async (spans) => {
    await bulkInsertSpans(spans);
  },
});
