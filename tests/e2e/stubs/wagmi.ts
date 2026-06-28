// Browser stub for wagmi. Exports only the hooks the cards use. The
// mock state lives on window.__cryptoMockAccount so the spec can flip
// it via page.evaluate() between assertions. useSyncExternalStore
// forces a re-render when the RainbowKit stub (or any test) dispatches
// the "crypto:mock-connected" event after flipping the mock account.

import { useSyncExternalStore } from "react";

type MockAccount = {
  isConnected: boolean;
  address?: `0x${string}`;
  chainId?: number;
};

type GlobalWithAccount = typeof globalThis & {
  __cryptoMockAccount?: MockAccount;
  __cryptoMockListeners?: Set<() => void>;
};

// Default disconnect state — must be a stable reference so
// useSyncExternalStore's getSnapshot doesn't trigger an infinite loop
// when the harness is loaded without addInitScript.
const DEFAULT_DISCONNECTED: MockAccount = Object.freeze({
  isConnected: false,
  address: undefined,
  chainId: undefined,
}) as MockAccount;

function read(): MockAccount {
  return (globalThis as GlobalWithAccount).__cryptoMockAccount ?? DEFAULT_DISCONNECTED;
}

function subscribe(cb: () => void): () => void {
  const g = globalThis as GlobalWithAccount;
  g.__cryptoMockListeners ??= new Set();
  g.__cryptoMockListeners.add(cb);
  return () => {
    g.__cryptoMockListeners?.delete(cb);
  };
}

export function useAccount() {
  const acct = useSyncExternalStore(subscribe, read, read);
  return {
    address: acct.address,
    isConnected: acct.isConnected,
    chainId: acct.chainId,
  };
}

// Stubs the cards import but don't use (e.g. useSignTypedData).
export function useSignTypedData() {
  return {
    signTypedDataAsync: async () => "0xmocksig" as `0x${string}`,
  };
}

export function useSwitchChain() {
  return {
    switchChainAsync: async () => {},
    isPending: false,
  };
}
