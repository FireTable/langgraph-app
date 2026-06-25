// LangGraph's ToolNode wraps every tool result as a string. assistant-ui
// sometimes parses one level deep, sometimes not. Unwrap defensively until
// we hit a plain object.

export function unwrapToolResult<T = unknown>(raw: unknown, depth = 0): T | null {
  if (depth > 2) return null;
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return unwrapToolResult<T>(JSON.parse(raw), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as T;
  return null;
}
