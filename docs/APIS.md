# API Reference

Reference for the HTTP endpoints served by `app/api/`. Keep this in sync whenever routes change — schemas, status codes, or behaviors.

Base URL: same origin in development (`http://localhost:3000/api/...`).

## Conventions

- **Content type**: `application/json` for request and response bodies unless noted otherwise.
- **Thread metadata shape** (matches `RemoteThreadMetadata` from `@assistant-ui/react`):

  ```ts
  type ThreadMetadata = {
    status: "regular" | "archived";
    remoteId: string; // = threads.id in our schema = LangGraph thread_id
    title?: string;
    externalId?: string; // not currently used; reserved for cross-system refs
  };
  ```

- **List responses** are wrapped: `{ threads: ThreadMetadata[] }`.
- **Validation failures** return `400` with `{ error: ZodIssue[] }`.
- **Missing resources** return `404` with `{ error: "Not found" }`.

## Threads

### `GET /api/threads`

List regular threads for the sidebar. Excludes archived threads.

- **Query params**:
  - `cursor?: string` — reserved for pagination (currently unused).
- **Response 200**:
  ```json
  { "threads": ThreadMetadata[] }
  ```
- **Example**:
  ```bash
  curl http://localhost:3000/api/threads
  ```

### `POST /api/threads`

Create a new thread. Called by `RemoteThreadListAdapter.initialize()`.

- **Request body** (all fields optional):
  ```json
  { "title": "Optional title" }
  ```
- **Response 201**: returns the new thread metadata, including the generated `remoteId` (nanoid, 12 chars).
- **Response 400**: validation failure.

### `GET /api/threads/[id]`

Fetch one thread's metadata. Called by `RemoteThreadListAdapter.fetch()`.

- **Response 200**: `ThreadMetadata`
- **Response 404**: thread not found.

### `PATCH /api/threads/[id]`

Update a thread. The body is a discriminated union — exactly one of the three shapes:

```ts
type PatchBody =
  | { title: string } // rename
  | { status: "regular" | "archived" } // archive / unarchive
  | { custom: Record<string, unknown> }; // replace custom jsonb
```

- **Response 200**: updated `ThreadMetadata`.
- **Response 400**: empty body or none of the keys match.
- **Response 404**: thread not found.

### `DELETE /api/threads/[id]`

Remove a thread's metadata row. Called by `RemoteThreadListAdapter.delete()`.

- **Response 204**: no content.
- **Response 404**: thread not found.

> The corresponding LangGraph checkpoint rows (in `checkpoints` / `checkpoint_blobs` / `checkpoint_writes`) are **not** deleted by this endpoint. To fully purge a conversation, also delete the thread via the LangGraph SDK or Postgres directly.

### `POST /api/threads/[id]/title`

Generate a short title for a thread from the first user message. Called by `RemoteThreadListAdapter.generateTitle()`.

- **Request body**:
  ```json
  { "messages": [{ "role": "user" | "assistant" | "system", "content": string }] }
  ```
  - `messages.length` must be 1–20.
- **Response 200**: a `text/event-stream` body that streams the title as a single chunk.
- **Response 400**: validation failure.

The current implementation takes the first 8 words of the first user message. A future iteration can swap in an LLM call.

## Error format

All errors use the same envelope:

```ts
type ErrorResponse = {
  error: string | ZodIssue[];
};

type ZodIssue = {
  code: string;
  path: (string | number)[];
  message: string;
};
```

## Client integration

The frontend wires these endpoints via `lib/threads/adapter.ts`, which implements `RemoteThreadListAdapter` from `@assistant-ui/react` and is passed to `useStreamRuntime({ unstable_threadListAdapter })`.

## Adding or changing endpoints

1. Update the route handler under `app/api/`.
2. Update the matching Zod schema in `lib/threads/validators.ts` (or create a new validators file for a new resource).
3. Update tests in `tests/api/`.
4. **Update this file** to keep the documentation accurate.
5. Update `README.md` if the surface area changes for end users.
