// R2 key factory. All key construction in the app goes through here so
// the layout lives in one place and tests can mock it without touching
// route code.
//
// Layout (see docs/ATTACHMENTS.md "R2 key convention"):
//
//   <R2_FOLDER_USER>/<userId>/
//     upload/<sha256>.<ext>   — content-addressed (CAS). Same bytes → same key →
//                                dedup is automatic at the storage layer. Used by
//                                chat attachments (browser presign) and by the KB
//                                URL-fetch flow (server putObject for fetched md).
//     avatar.png              — fixed slot. One avatar per user; re-upload
//                                overwrites in place. Better-auth-ui's resize hook
//                                transcodes any input format to PNG via canvas, so
//                                the extension is constant — server never sees jpg.
//     kb/<sha256>.<ext>       — content-addressed (CAS). KB ingest derives page
//                                screenshots + embedded images from a doc; a second
//                                ingest of the same doc produces no new bytes,
//                                and the same logo embedded in N PDFs reuses one
//                                R2 object.

import { getR2FolderUser } from "@/lib/r2/client";

const AVATAR_EXT = "png";

export type UploadKeyArgs = { userId: string; sha256: string; ext: string };
export type KbKeyArgs = { userId: string; sha256: string; ext: string };
export type AvatarKeyArgs = { userId: string };

export type R2Keys = ReturnType<typeof r2Keys>;

export function r2Keys() {
  const user = getR2FolderUser();

  return {
    upload: (args: UploadKeyArgs): string =>
      `${user}/${args.userId}/upload/${args.sha256}.${args.ext}`,

    kb: (args: KbKeyArgs): string => `${user}/${args.userId}/kb/${args.sha256}.${args.ext}`,

    avatar: (args: AvatarKeyArgs): string => `${user}/${args.userId}/avatar.${AVATAR_EXT}`,
  };
}
