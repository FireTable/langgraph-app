// Aggregate schema entry for drizzle-kit. Each business module owns its
// table definition under lib/<module>/schema.ts; we re-export here so
// drizzle-kit sees a single file.

export * from "@/lib/threads/schema";
export * from "@/lib/auth/schema";
export * from "@/lib/observability/schema";
export * from "@/lib/attachments/schema";
