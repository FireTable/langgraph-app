// ponytail: every /api fetch from the browser needs to carry the Better Auth
// session cookie. fetchWithAuth defaults credentials to "include" so a future
// cross-origin deploy (subdomain split, staging rewrites) can't silently
// drop auth by forgetting the option.

type FetchWithAuthInit = Omit<RequestInit, "body" | "headers"> & {
  body?: unknown;
  headers?: HeadersInit;
};

export function fetchWithAuth(url: string, init: FetchWithAuthInit = {}): Promise<Response> {
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
