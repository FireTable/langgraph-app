import { useQueryClient } from "@tanstack/react-query";
import type { BetterFetchError } from "better-auth/react";
import { useEffect } from "react";
import { toast } from "sonner";

export function ErrorToaster() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const previousQueryOnError = queryCache.config.onError;

    queryCache.config.onError = (error, query) => {
      previousQueryOnError?.(error, query);

      const err = error as BetterFetchError;
      if (err?.error?.code === "EMAIL_NOT_VERIFIED") return;
      const message = err?.error?.message || err?.message;
      if (message) toast.error(message);
    };

    const mutationCache = queryClient.getMutationCache();
    const previousMutationOnError = mutationCache.config.onError;

    mutationCache.config.onError = (error, variables, onMutateResult, mutation, context) => {
      previousMutationOnError?.(error, variables, onMutateResult, mutation, context);

      const err = error as BetterFetchError;
      if (err?.error?.code === "EMAIL_NOT_VERIFIED") return;
      const message =
        err?.error?.message || err?.message || (typeof error === "string" ? error : null);
      if (message) toast.error(message);
    };

    return () => {
      queryCache.config.onError = previousQueryOnError;
      mutationCache.config.onError = previousMutationOnError;
    };
  }, [queryClient]);

  return null;
}
