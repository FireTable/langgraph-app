import { describe, it, expect } from "vitest";
import {
  CreateThreadBody,
  RenameThreadBody,
  UpdateStatusBody,
  UpdateCustomBody,
} from "@/lib/threads/validators";

describe("CreateThreadBody", () => {
  it("accepts empty object (title optional)", () => {
    expect(CreateThreadBody.safeParse({}).success).toBe(true);
  });

  it("accepts valid title", () => {
    const r = CreateThreadBody.safeParse({ title: "hello" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe("hello");
  });

  it("rejects empty string title", () => {
    expect(CreateThreadBody.safeParse({ title: "" }).success).toBe(false);
  });

  it("rejects title > 200 chars", () => {
    expect(CreateThreadBody.safeParse({ title: "a".repeat(201) }).success).toBe(false);
  });

  it("rejects non-string title", () => {
    expect(CreateThreadBody.safeParse({ title: 123 }).success).toBe(false);
  });
});

describe("RenameThreadBody", () => {
  it("accepts valid title", () => {
    expect(RenameThreadBody.safeParse({ title: "new name" }).success).toBe(true);
  });

  it("rejects empty title", () => {
    expect(RenameThreadBody.safeParse({ title: "" }).success).toBe(false);
  });

  it("rejects title > 200 chars", () => {
    expect(RenameThreadBody.safeParse({ title: "a".repeat(201) }).success).toBe(false);
  });
});

describe("UpdateStatusBody", () => {
  it("accepts 'regular'", () => {
    expect(UpdateStatusBody.safeParse({ status: "regular" }).success).toBe(true);
  });

  it("accepts 'archived'", () => {
    expect(UpdateStatusBody.safeParse({ status: "archived" }).success).toBe(true);
  });

  it("rejects other values", () => {
    expect(UpdateStatusBody.safeParse({ status: "deleted" }).success).toBe(false);
  });
});

describe("UpdateCustomBody", () => {
  it("accepts empty object", () => {
    expect(UpdateCustomBody.safeParse({ custom: {} }).success).toBe(true);
  });

  it("accepts nested object", () => {
    const r = UpdateCustomBody.safeParse({ custom: { a: 1, b: { c: "x" } } });
    expect(r.success).toBe(true);
  });
});
