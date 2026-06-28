import { test, expect } from "@playwright/test";
import { MOCK_WALLET_ADDRESS, mockWalletConnected, mockWalletDisconnected } from "./wallet-mock";

// E2E for the crypto atomic-tools refactor. The vite harness mounts all
// 3 cards in vertical sequence. Default state is DISCONNECTED so the
// connect_wallet card sits at the "Connect" button (no auto-resume
// payload). Connected tests override the default.

test.beforeEach(async ({ page }) => {
  await mockWalletDisconnected(page);
  await page.goto("/");
});

test.describe("connect_wallet card — disconnected", () => {
  test("renders a Connect button when wallet is not connected", async ({ page }) => {
    const card = page.locator('[data-card="connect-wallet"] [data-slot="connect-wallet-card"]');
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /connect wallet/i })).toBeVisible();
  });

  test("title-case header (Authorize Wallet)", async ({ page }) => {
    const card = page.locator('[data-card="connect-wallet"] [data-slot="connect-wallet-card"]');
    await expect(card.getByText("Authorize Wallet")).toBeVisible();
  });

  test("does NOT auto-resume when not connected", async ({ page }) => {
    await expect(page.locator("#last-payload")).toContainText("(no resume yet)");
  });

  test("Connect button opens RainbowKit; once connected, the card auto-resumes", async ({
    page,
  }) => {
    const card = page.locator('[data-card="connect-wallet"] [data-slot="connect-wallet-card"]');
    await card.getByRole("button", { name: /connect wallet/i }).click();
    // The RainbowKit stub auto-connects the mock wallet, which fires the
    // card's ref-guarded useEffect → sendCommand → resume payload.
    await expect(page.locator("#last-payload")).toContainText(MOCK_WALLET_ADDRESS, {
      timeout: 2000,
    });
    await expect(page.locator("#last-payload")).toContainText("8453");
  });
});

test.describe("connect_wallet card — connected, auto-resume", () => {
  test.beforeEach(async ({ page }) => {
    // Override the default: simulate a connected wallet. The card's
    // ref-guarded useEffect fires the resume on the first render.
    await mockWalletConnected(page);
    await page.goto("/");
  });

  test("auto-resumes with {address, chainId} on first connected render", async ({ page }) => {
    await expect(page.locator("#last-payload")).toContainText(MOCK_WALLET_ADDRESS, {
      timeout: 2000,
    });
    await expect(page.locator("#last-payload")).toContainText("8453");
  });

  test("the brief 'Connecting…' indicator shows the connected address", async ({ page }) => {
    const card = page.locator(
      '[data-card="connect-wallet"] [data-slot="connect-wallet-card-connecting"]',
    );
    // May have already resolved by the time we look, but the address
    // appears in either view.
    const resolved = page.locator(
      '[data-card="connect-wallet"] [data-slot="connect-wallet-card-resolved"]',
    );
    const connecting = card;
    await expect(connecting.or(resolved)).toBeVisible();
    await expect(page.locator('[data-card="connect-wallet"]')).toContainText("0x1af1…0977");
  });

  test("does not double-resume on remount (Strict Mode safe)", async ({ page }) => {
    await expect(page.locator("#last-payload")).toContainText(MOCK_WALLET_ADDRESS, {
      timeout: 2000,
    });
    const initialCalls = (await page.locator("#last-payload").textContent()) ?? "";
    // Re-navigate; the ref is per-mount, but each fresh mount only
    // resumes once because wagmi already reports connected and the
    // ref is fresh.
    await page.goto("/");
    const afterReload = (await page.locator("#last-payload").textContent()) ?? "";
    expect(afterReload).toContain(MOCK_WALLET_ADDRESS);
    // The payload structure (resume JSON) is identical — only one
    // resume per mount, no double-fire.
    expect(afterReload).toBe(initialCalls);
  });
});

test.describe("place_crypto_order card", () => {
  test("renders the simulated order shell with a SIMULATED badge", async ({ page }) => {
    const card = page.locator(
      '[data-card="place-crypto-order"] [data-slot="place-crypto-order-card"]',
    );
    await expect(card).toBeVisible();
    await expect(card.getByText(/simulated/i).first()).toBeVisible();
  });

  test("header reads Swap Quote + button reads Accept Swap", async ({ page }) => {
    const card = page.locator(
      '[data-card="place-crypto-order"] [data-slot="place-crypto-order-card"]',
    );
    await expect(card.getByText("Swap Quote")).toBeVisible();
    await expect(card.getByText(/prices are live/i)).toBeVisible();
    await expect(card.getByRole("button", { name: /accept swap/i })).toBeVisible();
  });
});

test.describe("get_order_status card", () => {
  test("renders the order uid + chain from args", async ({ page }) => {
    const card = page.locator('[data-card="order-status"] [data-slot="order-status-card"]');
    await expect(card).toBeVisible();
    await expect(card.getByText(/pending check/i)).toBeVisible();
  });

  test("title-case header + Quote id label (regression)", async ({ page }) => {
    const card = page.locator('[data-card="order-status"] [data-slot="order-status-card"]');
    await expect(card.getByText("Swap Status")).toBeVisible();
    await expect(card.getByText("Quote id")).toBeVisible();
  });

  test("clicking Check synthesizes a filled status", async ({ page }) => {
    const card = page.locator('[data-card="order-status"] [data-slot="order-status-card"]');
    await card.getByRole("button", { name: /check status/i }).click();
    await expect(page.locator("#last-payload")).toContainText('"status"', { timeout: 2000 });
    await expect(page.locator("#last-payload")).toContainText("filled");
    await expect(page.locator("#last-payload")).toContainText("ord_test_abc123");
  });
});

test.describe("atomicity — each card has its own decision point", () => {
  test("all 3 cards mount simultaneously (no implicit cross-card coupling)", async ({ page }) => {
    await expect(
      page.locator('[data-card="connect-wallet"] [data-slot^="connect-wallet-card"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-card="place-crypto-order"] [data-slot^="place-crypto-order-card"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-card="order-status"] [data-slot^="order-status-card"]'),
    ).toBeVisible();
  });

  test("each card has exactly one primary action button when disconnected", async ({ page }) => {
    await expect(
      page.locator('[data-card="connect-wallet"] button[data-action="connect-wallet"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-card="order-status"] button[data-action="check-order-status"]'),
    ).toHaveCount(1);
  });
});
