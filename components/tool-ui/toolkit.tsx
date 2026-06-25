"use client";

import { defineToolkit } from "@assistant-ui/react";
import { z } from "zod";

import { AskLocationCard } from "@/components/tool-ui/ask-location/ask-location-card";
import { WeatherCard } from "@/components/tool-ui/weather/weather-card";
import {
  AskCryptoIntentCard,
  CryptoOrderReceiptCard,
  CryptoPriceCard,
} from "@/components/tool-ui/crypto";

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
    // No render — geocode is fast (≤300ms) and is an internal helper,
    // not user-facing. Showing a card here would be noise.
    render: () => null,
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
  ask_crypto_intent: {
    description:
      "Render a buy/sell form card. Pauses the turn; the form's submit resumes with the pick.",
    parameters: z.object({}),
    render: AskCryptoIntentCard,
  },
  get_crypto_price: {
    description: "Fetch and render a price card for one or more coins.",
    parameters: z.object({
      ids: z.array(z.string()),
      vs_currency: z.string().optional(),
    }),
    render: CryptoPriceCard,
  },
  confirm_crypto_order: {
    description: "Render a simulated order receipt.",
    parameters: z.object({
      coin_id: z.string(),
      coin_symbol: z.string(),
      amount_usd: z.number(),
      price_at_confirm: z.number(),
      side: z.enum(["buy", "sell"]),
    }),
    render: CryptoOrderReceiptCard,
  },
});

export default defineToolkit({
  ...weatherToolkit,
  ...cryptoToolkit,
});
