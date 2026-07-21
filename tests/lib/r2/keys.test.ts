import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { r2Keys } from "@/lib/r2/keys";

// ponytail: factory has no internal state and reads env at call time
// (matching getR2FolderUser's "missing → default" contract). Stub env
// per test rather than at module-load time so behaviour is observable.
const ORIGINAL_FOLDER = process.env.R2_FOLDER_USER;

beforeEach(() => {
  delete process.env.R2_FOLDER_USER;
});

afterEach(() => {
  if (ORIGINAL_FOLDER === undefined) delete process.env.R2_FOLDER_USER;
  else process.env.R2_FOLDER_USER = ORIGINAL_FOLDER;
});

describe("r2Keys().upload", () => {
  it("uses content-addressed form by default", () => {
    const key = r2Keys().upload({
      userId: "u-1",
      sha256: "abc123",
      ext: "png",
    });
    expect(key).toBe("u/u-1/upload/abc123.png");
  });

  it("honours R2_FOLDER_USER override", () => {
    process.env.R2_FOLDER_USER = "tenant";
    const key = r2Keys().upload({
      userId: "u-1",
      sha256: "abc123",
      ext: "jpg",
    });
    expect(key).toBe("tenant/u-1/upload/abc123.jpg");
  });

  it("preserves any ext (md, png, jpeg, ...)", () => {
    expect(r2Keys().upload({ userId: "u-1", sha256: "x".repeat(64), ext: "md" })).toBe(
      "u/u-1/upload/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.md",
    );
  });
});

describe("r2Keys().kb", () => {
  it("uses content-addressed form scoped to userId only (no docId)", () => {
    // docId is intentionally omitted from the path — same sha256 means
    // same bytes; deleting a doc leaves the R2 object as orphan, but
    // other docs that embed the same image keep working.
    const key = r2Keys().kb({
      userId: "u-1",
      sha256: "deadbeef",
      ext: "png",
    });
    expect(key).toBe("u/u-1/kb/deadbeef.png");
  });

  it("honours R2_FOLDER_USER override", () => {
    process.env.R2_FOLDER_USER = "tenant";
    expect(r2Keys().kb({ userId: "u-2", sha256: "cafebabe", ext: "png" })).toBe(
      "tenant/u-2/kb/cafebabe.png",
    );
  });
});

describe("r2Keys().avatar", () => {
  it("uses a fixed-slot .png key — better-auth-ui always transcodes to PNG", () => {
    expect(r2Keys().avatar({ userId: "u-1" })).toBe("u/u-1/avatar.png");
  });

  it("does not accept an ext arg (always PNG)", () => {
    // Typing-level guarantee: the factory signature omits `ext`. If a
    // caller wanted to override, they'd be reaching past the type
    // system. Document the intent at runtime too.
    const args = r2Keys().avatar as unknown as (a: { userId: string; ext?: string }) => string;
    expect(args({ userId: "u-1", ext: "webp" })).toBe("u/u-1/avatar.png");
  });

  it("honours R2_FOLDER_USER override", () => {
    process.env.R2_FOLDER_USER = "tenant";
    expect(r2Keys().avatar({ userId: "u-1" })).toBe("tenant/u-1/avatar.png");
  });
});

describe("r2Keys() instance stability", () => {
  it("returns the same key for the same input within a call", () => {
    const keys = r2Keys();
    const a = keys.upload({ userId: "u-1", sha256: "x", ext: "png" });
    const b = keys.upload({ userId: "u-1", sha256: "x", ext: "png" });
    expect(a).toBe(b);
  });

  it("reads R2_FOLDER_USER at call time, not module load", () => {
    const before = r2Keys().avatar({ userId: "u-1" });
    process.env.R2_FOLDER_USER = "tenant";
    const after = r2Keys().avatar({ userId: "u-1" });
    expect(before).toBe("u/u-1/avatar.png");
    expect(after).toBe("tenant/u-1/avatar.png");
  });
});
