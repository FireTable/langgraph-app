# Contract: `save_memory` Tool

**Branch**: `feat/003-langgraph-store` | **Date**: 2026-07-02 | **Spec**: [spec.md § FR-001..FR-004](./spec.md) | **Data Model**: [data-model.md § Entity 1](./data-model.md)

## 概述

`save_memory` 是 agent 写入长期记忆的**唯一**工具。无 `forget_memory`,删除走 patch `remove` op。

| 属性        | 值                                                                                    |
| ----------- | ------------------------------------------------------------------------------------- |
| 名称        | `save_memory`                                                                         |
| 类别        | 长期记忆写入                                                                          |
| 注册位置    | `backend/tool/memory/save-memory-tool.ts`,挂入 `backend/tool/index.ts` 的 `ALL_TOOLS` |
| 入参 schema | JSON Patch 数组(RFC 6902,只允许 `add` / `replace` / `remove`)                         |
| 出参 schema | `{ ok: true, bytes: number }` 或 抛出 `MemorySizeError`                               |
| 触发者      | `chatModelNode`(任何 model node 若挂 `ALL_TOOLS` 都能调用)                            |
| 副作用      | 修改 PostgresStore `[userId, "profile"]` key=`main`                                   |

## Input Schema

### 工具参数(LLM 视角)

```ts
{
  patches: JSONPatch[]   // 1..N 条 patch 操作
}
```

### `JSONPatch` 单条定义

```ts
type JSONPatch = AddOp | ReplaceOp | RemoveOp;

type AddOp = {
  op: "add";
  path: string; // RFC 6901 JSON Pointer,如 "/role"
  value: unknown; // 任意 JSON-compatible value
};

type ReplaceOp = {
  op: "replace";
  path: string;
  value: unknown;
};

type RemoveOp = {
  op: "remove";
  path: string;
  // no `value`
};
```

### Zod 校验(`lib/memory/validators.ts`)

```ts
const PatchBase = z.object({ path: z.string().regex(/^\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/) });

export const AddPatch = PatchBase.extend({
  op: z.literal("add"),
  value: z.unknown().refine((v) => v !== undefined, "add op requires value"),
});

export const ReplacePatch = PatchBase.extend({
  op: z.literal("replace"),
  value: z.unknown().refine((v) => v !== undefined, "replace op requires value"),
});

export const RemovePatch = PatchBase.extend({
  op: z.literal("remove"),
});

export const MemoryPatch = z.discriminatedUnion("op", [AddPatch, ReplacePatch, RemovePatch]);

export const SaveMemoryInput = z.object({
  patches: z.array(MemoryPatch).min(1).max(50),
});
```

**Notes**:

- `path` regex 限制 RFC 6901 风格 pointer,**禁止** `..` / 数组索引(避免越界与 prototype pollution)
- `op` 严格枚举:`move` / `copy` / `test` 一律拒绝(refine 抛错)
- `patches` 上限 50,防止模型一次 emit 过量

## Output Schema

### 成功

```ts
{
  ok: true;
  bytes: number; // 写入后 profile doc 的字节数(≤ MEMORY_PROFILE_MAX_BYTES)
  keyCount: number; // 写入后 profile doc 的 key 数
}
```

### 失败(抛错,ToolMessage 携带 error)

```ts
class MemorySizeError extends Error {
  readonly name = "MemorySizeError";
  constructor(
    public readonly attemptedBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`Memory write rejected: ${attemptedBytes} bytes exceeds ${maxBytes} byte limit`);
  }
}

class MemoryPatchError extends Error {
  readonly name = "MemoryPatchError";
  constructor(
    public readonly reason: string,
    public readonly op?: string,
    public readonly path?: string,
  ) {
    super(`Memory patch rejected: ${reason}`);
  }
}
```

- `MemorySizeError`:超过 `MEMORY_PROFILE_MAX_BYTES` —— 模型应拆 patch / 删字段后再试
- `MemoryPatchError`:patch 格式错、path 不存在(对 `replace` / `remove`)、`add` 路径冲突等

## 行为契约

### 流程(`backend/tool/memory/save-memory-tool.ts`)

```
1. userId = config.configurable?.userId
   if (!userId) → throw new Error("save_memory requires userId in config.configurable")
   // 注:工具只能在 user session 内调用,缺 userId 即 caller bug,直接 fail-fast

2. patches = SaveMemoryInput.parse(input)
   // zod parse 失败 → throw ZodError(模型收到 error message)

3. current = await store.get([userId, "profile"], "main")
   profile = current?.value ?? {}

4. after = structuredClone(profile)
   try:
     fastJsonPatch.apply(after, patches, /* validateOperation */ false, /* mutate */ true, /* banPrototypeModifications */ true)
   catch (e):
     throw new MemoryPatchError(e.message)

5. bytes = Buffer.byteLength(JSON.stringify(after), "utf8")
   if (bytes > MEMORY_PROFILE_MAX_BYTES:
     throw new MemorySizeError(bytes, MEMORY_PROFILE_MAX_BYTES)
   // fail-fast,未调 store.put

6. await store.put([userId, "profile"], "main", after)
   // 写覆盖整文档,无 transaction

7. return { ok: true, bytes, keyCount: Object.keys(after).length }
```

### 不变量

- 单文档写:profile 始终是单文档,无并发合并,last-write-wins
- 失败不留半写状态:`MemorySizeError` / `MemoryPatchError` 在 `store.put` 前抛
- patch 应用不可逆(无 audit / version,Out of Scope)

### 与 `runtime.store` 的关系

工具实现可走 `backend/store.ts` 直接 import `store`,**不必**走 `runtime.store` —— 工具不属于 graph node,不会自动获得 `Runtime` 上下文。但需要 `userId`,从 `config.configurable.userId` 取(由 proxy 注入,见 `research.md` D-006)。

## 测试矩阵

落在 `tests/backend/tool/memory/save-memory-tool.test.ts`(rule #2 TDD):

| Case                            | 期望                                          |
| ------------------------------- | --------------------------------------------- |
| 空 profile + 1 add patch        | `{ ok: true, bytes: <newSize>, keyCount: 1 }` |
| 已有 profile + add 新字段       | 合并,keyCount + 1                             |
| 已有 profile + replace 字段     | 覆盖,keyCount 不变                            |
| 已有 profile + remove 字段      | keyCount - 1                                  |
| 多个 patch 一次调用             | 按序应用                                      |
| size 超过 8KB                   | throw MemorySizeError,store 未变              |
| path 不存在的 remove            | throw MemoryPatchError,store 未变             |
| path 不存在的 replace           | throw MemoryPatchError,store 未变             |
| `op: "move"`                    | zod 拒绝(枚举不包含)                          |
| patches 数组为空                | zod 拒绝(min(1))                              |
| 缺 `config.configurable.userId` | 抛 Error,model 收到 fail message              |

每条 case 用 `vi.fn()` mock `store.put` / `store.get`,不连真实 Postgres(rule #2)。

## Open Questions

None。
