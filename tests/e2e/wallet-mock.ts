// Default mock wallet state for crypto card e2e tests. Specs call
// mockWalletConnected(page) or mockWalletDisconnected(page) in
// beforeEach — the wagmi stub reads this global on first render.
//
// Centralizes the default address so individual specs don't repeat it.

export const MOCK_WALLET_ADDRESS = "0x1af12147C80F6d7A57BF7eC11985a2F2a7630977";
export const MOCK_CHAIN_ID = 8453;

export async function mockWalletConnected(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(
    ([address, chainId]) => {
      (window as unknown as { __cryptoMockAccount: object }).__cryptoMockAccount = {
        isConnected: true,
        address,
        chainId,
      };
    },
    [MOCK_WALLET_ADDRESS, MOCK_CHAIN_ID],
  );
}

export async function mockWalletDisconnected(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __cryptoMockAccount: object }).__cryptoMockAccount = {
      isConnected: false,
      address: undefined,
      chainId: undefined,
    };
  });
}
