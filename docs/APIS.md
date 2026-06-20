# API Reference

Quick map of every HTTP endpoint under `app/api/`. For exact request/response shapes, status codes, and validation rules, read the route handler directly — the file path is the truth.

This doc exists so you can find your way around the API surface without grepping. Update it whenever a route is added, removed, or repurposed.

## Threads

Thread metadata, backing the assistant-ui sidebar. Implementation: `lib/threads/{queries,validators}.ts`. Adapter: `lib/threads/adapter.ts`.

| Endpoint                       | Purpose                                                                |
| ------------------------------ | ---------------------------------------------------------------------- |
| `GET /api/threads`             | List regular (non-archived) threads for the sidebar.                   |
| `POST /api/threads`            | Create a new thread; returns the generated `remoteId`.                 |
| `GET /api/threads/[id]`        | Fetch one thread's metadata.                                           |
| `PATCH /api/threads/[id]`      | Rename, archive, unarchive, or replace `custom` jsonb.                 |
| `DELETE /api/threads/[id]`     | Remove the thread metadata row (does not touch LangGraph checkpoints). |
| `POST /api/threads/[id]/title` | Generate a title from the first user message; streams the result.      |

## Proxy

| Endpoint             | Purpose                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANY /api/[...path]` | Edge catch-all that forwards to `LANGGRAPH_API_URL` (the LangGraph dev server / production endpoint). Strips hop-by-hop headers, adds CORS, optionally sends `x-api-key`. |
