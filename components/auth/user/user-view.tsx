"use client";

import { type UsernameAuthClient, useAuth, useSession } from "@better-auth-ui/react";
import type { User } from "better-auth";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./user-avatar";

// ponytail: the role pill text is read off `window.__CONFIG__` —
// `app/layout.tsx` resolves the current user's role row once per
// render (a single JOIN on the same DB the SUM credit check uses)
// and stamps the display name into the bootstrap script. No prop
// drilling, no extra fetch, no hard-coded admin/user/guest →
// display-name map that drifts when the role table gains a tier.
export type UserViewProps = {
  className?: string;
  isPending?: boolean;
  /**
   * When true, the subtitle line (email when name/username is shown) is hidden.
   * @default false
   */
  hideSubtitle?: boolean;
  /** @remarks `User` */
  user?: Partial<User> & {
    username?: string | null;
    displayUsername?: string | null;
    roleId?: string | null;
  };
};

/**
 * Render a compact user item with an avatar, a primary label (display username, name, or email), and an optional subtitle (email).
 *
 * @param isPending - If true and no `user` prop is provided, renders a loading skeleton instead of user details
 * @param className - Additional CSS classes applied to the outer container
 * @param hideSubtitle - When true, omits the muted subtitle row under the primary label
 * @param user - Optional user object to display; when omitted the current session user is used
 * @returns A React element showing the user's avatar with their identifying information
 */
export function UserView({ className, isPending, hideSubtitle = false, user }: UserViewProps) {
  const roleName = typeof window !== "undefined" ? window.__CONFIG__?.USER_ROLE_NAME : undefined;
  const { authClient } = useAuth();
  const { data: session, isPending: sessionPending } = useSession(
    authClient as UsernameAuthClient,
    { enabled: !user && !isPending },
  );

  const resolvedUser = user ?? session?.user;

  if ((isPending || sessionPending) && !user) {
    return (
      <div className={cn("flex items-center gap-2 min-w-0", className)}>
        <UserAvatar isPending />

        <div className="grid flex-1 gap-1 text-left text-sm">
          <Skeleton className="h-4 w-24" />

          {!hideSubtitle && <Skeleton className="h-3 w-32" />}
        </div>
      </div>
    );
  }

  const showSubtitle = !hideSubtitle && !!(resolvedUser?.displayUsername || resolvedUser?.name);

  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      <UserAvatar user={resolvedUser as User | undefined} />

      <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
        <span className="flex items-center gap-1.5 truncate font-medium text-foreground">
          <span className="truncate">
            {resolvedUser?.displayUsername || resolvedUser?.name || resolvedUser?.email}
          </span>
          {roleName && (
            <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize tracking-wide">
              {roleName}
            </span>
          )}
        </span>

        {showSubtitle && (
          <span className="text-muted-foreground truncate text-xs">{resolvedUser?.email}</span>
        )}
      </div>
    </div>
  );
}
