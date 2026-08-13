// ponytail: aUI's runtime gives every fresh thread a stand-in id
// prefixed with `__LOCALID_<rand>` (CLAUDE.md § assistant-ui notes the
// exact shape). The `__LOCAL` prefix (NO trailing underscore) catches
// both `__LOCALID_<rand>` and the older `__LOCAL_<rand>` shape the
// docs warn about; a tighter `__LOCAL_` prefix would miss
// `__LOCALID_<rand>` entirely.
//
// The canvas fetch + the auto-save PUT both URL-encode the threadId;
// hand them a placeholder and the server either 404s the row lookup or
// creates a stray row that no real thread ever resumes.
//
// `isPlaceholderThread` is the single guard the canvas stack uses to
// short-circuit both paths.

export const LOCAL_THREAD_PREFIX = "__LOCAL";

export function isPlaceholderThread(threadId: string | null | undefined): boolean {
  return !!threadId && threadId.startsWith(LOCAL_THREAD_PREFIX);
}
