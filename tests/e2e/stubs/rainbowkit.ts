// Browser stub for @rainbow-me/rainbowkit. The connect card only uses
// useConnectModal(); expose an openConnectModal that flips the mock
// account state and notifies wagmi listeners so React re-renders.

type GlobalWithAccount = typeof globalThis & {
  __cryptoMockAccount?: { isConnected: boolean; address?: `0x${string}`; chainId?: number };
  __cryptoMockListeners?: Set<() => void>;
};

function notify() {
  const g = globalThis as GlobalWithAccount;
  g.__cryptoMockListeners?.forEach((cb) => cb());
}

export function useConnectModal() {
  return {
    openConnectModal: () => {
      (globalThis as GlobalWithAccount).__cryptoMockAccount = {
        isConnected: true,
        address: "0x1af12147C80F6d7A57BF7eC11985a2F2a7630977",
        chainId: 8453,
      };
      notify();
      window.dispatchEvent(new Event("crypto:mock-connected"));
    },
  };
}

// useAccountModal — used by the connect_wallet card's "Use a different
// wallet" dropdown. In the e2e harness we don't render an actual modal;
// the stub just notifies listeners so the card re-renders into the
// "switched" state (the test asserts no resume was sent, which is the
// important contract).
export function useAccountModal() {
  return {
    openAccountModal: () => {
      window.dispatchEvent(new Event("crypto:mock-account-modal-opened"));
    },
  };
}
