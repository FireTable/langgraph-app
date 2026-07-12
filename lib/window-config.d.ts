// ponytail: client-visible config injected by `app/layout.tsx` from
// server-only env. Single source of truth across client + server, no
// build-time inlining, no rebuild-on-env-change. Empty / unset values
// come through as `undefined` (JSON.stringify drops them); callers must
// handle the undefined case (defaults, feature gates that fall through
// to "off", etc).

declare global {
  interface Window {
    __CONFIG__?: {
      LANGGRAPH_ASSISTANT_ID?: string;
      LANGGRAPH_PUBLIC_URL?: string;
      WALLET_CONNECT_PROJECT_ID?: string;
      R2_ALLOWED_CONTENT_TYPES?: string;
      ATTACHMENTS_ENABLED?: string;
      USER_ROLE_NAME?: string;
    };
  }
}

export {};
