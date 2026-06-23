import {
  AuthProvider as AuthProviderPrimitive,
  type AuthProviderProps,
} from "@better-auth-ui/react";
import type { ComponentPropsWithoutRef, ComponentType, PropsWithChildren, ReactNode } from "react";

import { ErrorToaster } from "./error-toaster";

declare module "@better-auth-ui/core" {
  interface AuthConfig {
    /**
     * React component used to render internal navigation links.
     * Typically TanStack Router's `Link` or Next.js's `Link`.
     */
    Link: ComponentType<
      PropsWithChildren<
        { className?: string; href: string; to?: string } & Pick<
          ComponentPropsWithoutRef<"a">,
          "aria-disabled" | "tabIndex" | "onClick"
        >
      >
    >;
  }

  /** Widen `AdditionalField.label` to `ReactNode` in the shadcn package. */
  interface AdditionalFieldRegister {
    label: ReactNode;
  }

  // ponytail: registry-installed components read these fields off plugin
  // objects at runtime, but @better-auth-ui/core 1.6.27's AuthPluginBase
  // doesn't surface them in its public types. Expose them as optional so TS
  // doesn't error on the build.
  type PluginViewComponentProps = {
    className?: string;
    socialLayout?: "auto" | "horizontal" | "grid" | "vertical";
    socialPosition?: "top" | "bottom";
  };
  type PluginAuthButtonComponentProps = {
    className?: string;
    view?: "signIn" | "signUp";
  };
  type PluginUserMenuItemProps = Record<string, unknown>;
  interface AuthPluginBase {
    views?: {
      auth?: Record<string, ComponentType<PluginViewComponentProps>>;
    };
    fallbackViews?: {
      auth?: Record<string, ComponentType<PluginViewComponentProps>>;
    };
    captchaComponent?: ComponentType<{ localization: unknown }>;
    authButtons?: ComponentType<PluginAuthButtonComponentProps>[];
    userMenuItems?: ComponentType<PluginUserMenuItemProps>[];
  }
}

/**
 * Provides an authentication context by rendering an auth provider with the sonner toast handler injected, forwarding remaining configuration and rendering `children` inside it.
 *
 * @param children - React nodes to render inside the authentication provider
 * @returns A React element that renders an authentication provider configured with the provided props and toast handler
 */
export function AuthProvider({ children, ...config }: AuthProviderProps) {
  return (
    <AuthProviderPrimitive {...config}>
      {children}

      <ErrorToaster />
    </AuthProviderPrimitive>
  );
}
