import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock factory — `vi.mock` is hoisted above imports, so the
// PostgresStore class needs to be defined here, not in a beforeEach.
const { mockFromConnString, mockSetup } = vi.hoisted(() => ({
  mockFromConnString: vi.fn(),
  mockSetup: vi.fn(),
}));

vi.mock("@langchain/langgraph-checkpoint-postgres/store", () => {
  class FakePostgresStore {
    static fromConnString = mockFromConnString;
    setup = mockSetup;
  }
  return { PostgresStore: FakePostgresStore };
});

describe("backend/store", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    mockFromConnString.mockReset();
    mockSetup.mockReset().mockResolvedValue(undefined);
    mockFromConnString.mockImplementation(() => ({ setup: mockSetup }) as never);
    vi.resetModules();
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("exports a PostgresStore instance built from DATABASE_URL and never runs setup() at module load", async () => {
    process.env.DATABASE_URL = "postgres://test/test";
    const { store } = await import("@/backend/store");

    expect(store).toBeDefined();
    expect(mockFromConnString).toHaveBeenCalledTimes(1);
    expect(mockFromConnString).toHaveBeenCalledWith("postgres://test/test");
    // ponytail: setup() now runs from `pnpm db:migrate` (scripts/db-migrate.ts),
    // not at module load — module-load side effects race under `next build`'s
    // N parallel page-data workers and break CI deterministically.
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("exports undefined when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const { store } = await import("@/backend/store");

    expect(store).toBeUndefined();
    expect(mockFromConnString).not.toHaveBeenCalled();
    expect(mockSetup).not.toHaveBeenCalled();
  });
});
