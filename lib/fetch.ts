// ponytail: every same-origin /api fetch from the browser needs cookies
// (Better Auth session cookie). Without `credentials: "include"`, fetch
// defaults to `same-origin` which works for same-origin requests today,
// but if we ever serve the API from a different origin (subdomain split,
// staging rewrites) we'd silently lose auth. Defaulting to "include" up
// here makes the behavior the same in both cases.

type JsonFetchInit = Omit<RequestInit, "body" | "headers"> & {
  body?: unknown;
  headers?: HeadersInit;
};

export function jsonFetch(url: string, init: JsonFetchInit = {}): Promise<Response> {
  const { body, headers, ...rest } = init;
  return fetch(url, {
    ...rest,
    credentials: "include",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
