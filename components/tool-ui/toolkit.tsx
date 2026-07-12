"use client";

import { defineToolkit } from "@assistant-ui/react";
import { z } from "zod";

import { AskLocationCard } from "@/components/tool-ui/ask-location/ask-location-card";
import { WeatherCard } from "@/components/tool-ui/weather/weather-card";
import {
  ConnectWalletCard,
  CryptoPriceCard,
  NftGalleryCard,
  OrderStatusCard,
  PlaceCryptoOrderCard,
} from "@/components/tool-ui/crypto";
import { WriteCodeCard, ExecuteCodeResult } from "@/components/tool-ui/code";
import { SaveMemoryCard } from "@/components/tool-ui/memory";
import { CreditCard } from "@/components/tool-ui/credit";

// Frontend-side tool registrations. `execute` lives on the LangGraph
// backend (backend/tool/) and is dispatched via useLangGraphRuntime —
// these `render` callbacks only attach the matching UI to the
// tool-call message part.

const weatherToolkit = defineToolkit({
  ask_location: {
    description: "Render a location picker card. No-op on the server.",
    parameters: z.object({}),
    render: AskLocationCard,
  },
  geocode_location: {
    description: "Geocode a place name. Server returns coords or an error.",
    parameters: z.object({ query: z.string() }),
  },
  get_weather: {
    description: "Fetch and render the weather widget for the given coords.",
    parameters: z.object({
      location: z.string(),
      latitude: z.number(),
      longitude: z.number(),
      unit: z.enum(["celsius", "fahrenheit"]).optional(),
    }),
    render: WeatherCard,
  },
});

const cryptoToolkit = defineToolkit({
  get_crypto_price: {
    description: "Fetch and render a price card for one or more coins.",
    parameters: z.object({
      ids: z.array(z.string()),
      vs_currency: z.string().optional(),
    }),
    render: CryptoPriceCard,
  },
  connect_wallet: {
    description: "Render a wallet-authorization card. No-op on the server.",
    parameters: z.object({
      message: z.string().optional(),
    }),
    render: ConnectWalletCard,
  },
  place_crypto_order: {
    // Pauses for one user click. Reads the wallet from wagmi
    // (auto-inferred from the most recent connect_wallet ToolMessage);
    // spends from the auto-funded Mock Coin balance, prices the
    // receive-side token via live CoinGecko USD, and on click
    // synthesizes a simulated order — no real signing, no broadcast.
    description: "Render a simulated swap card and pause for the user to click Place order.",
    parameters: z.object({
      side: z.enum(["buy", "sell"]),
      source_coin_id: z.string().optional(),
      amount: z.number().optional(),
      target_coin_id: z.string().optional(),
    }),
    render: PlaceCryptoOrderCard,
  },
  get_order_status: {
    description: "Render an order-status card and pause for the user to click Check.",
    parameters: z.object({
      order_uid: z.string(),
      chain_id: z.number(),
    }),
    render: OrderStatusCard,
  },
  get_NFT_holdings: {
    description: "Fetch and render an NFT gallery for the given wallet address.",
    parameters: z.object({
      address: z.string(),
    }),
    render: NftGalleryCard,
  },
});

const codeToolkit = defineToolkit({
  write_code: {
    description:
      "Render a code editor card. Pauses for the user to review and click Run. The card sends a resume payload to the model; the model then calls execute_code with the returned code.",
    parameters: z.object({
      code: z.string(),
      language: z.string().optional(),
    }),
    render: WriteCodeCard,
  },
  execute_code: {
    description:
      "Run TypeScript in a Deno Deploy Sandbox. Read-only result card. Tool is only registered when DENO_DEPLOY_TOKEN is set; the server-side filter handles the missing-token case.",
    parameters: z.object({
      code: z.string(),
      input: z.unknown().optional(),
      timeoutMs: z.number().optional(),
    }),
    render: ExecuteCodeResult,
  },
});

const memoryToolkit = defineToolkit({
  save_memory: {
    description:
      "Render a card showing what was added/updated/removed in the user's memory. Read-only — the tool result already mutated the store.",
    parameters: z.object({
      patches: z.array(
        z.object({
          op: z.enum(["add", "replace", "remove"]),
          path: z.string(),
          value: z.unknown().optional(),
        }),
      ),
    }),
    render: SaveMemoryCard,
  },
});

const creditToolkit = defineToolkit({
  // ponytail: client-only render. No backend tool — the proxy injects
  // a tool_call with these args when the user's rolling-window credit
  // cap blocks a turn at app/api/[..._path]. The args ride on the
  // tool_call itself; no ToolMessage is emitted.
  show_credit_card: {
    description: "Render a credit-limit-reached card. Read-only.",
    parameters: z.object({
      resetAt: z.string(),
      limit: z.number(),
      used: z.number(),
      windowHours: z.number(),
    }),
    render: CreditCard,
  },
});

export default defineToolkit({
  ...weatherToolkit,
  ...cryptoToolkit,
  ...codeToolkit,
  ...memoryToolkit,
  ...creditToolkit,
});
