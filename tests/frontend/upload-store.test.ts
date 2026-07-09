import { describe, it, expect, beforeEach } from "vitest";
import { useUploadStore, beginUpload, endUpload } from "@/lib/attachments/upload-store";

// ponytail: counter-based active flag. Multiple attachments upload in
// parallel via Promise.all, so a single boolean would flicker — second
// attachment's begin() would re-set true while first's end() already
// cleared it. Counter is the simplest fix and matches the
// Promise.all semantics SDK uses.

describe("upload-store", () => {
  beforeEach(() => {
    // reset between tests — zustand stores are module-level singletons.
    useUploadStore.setState({ count: 0 });
  });

  it("starts at zero", () => {
    expect(useUploadStore.getState().count).toBe(0);
  });

  it("beginUpload increments the counter", () => {
    beginUpload();
    expect(useUploadStore.getState().count).toBe(1);
  });

  it("endUpload decrements the counter", () => {
    beginUpload();
    beginUpload();
    endUpload();
    expect(useUploadStore.getState().count).toBe(1);
  });

  it("never goes negative on extra endUpload calls", () => {
    endUpload();
    expect(useUploadStore.getState().count).toBe(0);
  });

  it("parallel begin/end (Promise.all shape) balances to zero", () => {
    // SDK uploads attachments via Promise.all(adapter.send). Two
    // attachments → two begin() calls before either end() runs.
    beginUpload();
    beginUpload();
    endUpload();
    endUpload();
    expect(useUploadStore.getState().count).toBe(0);
  });
});
