// ponytail: UI-only transform for profile keys. Store keys stay raw
// (deletion, save_memory patches, profile API) — this only changes
// the visible label. Splits on _/- and capitalizes each word so a
// raw `travel_preferences` renders as `Travel Preferences`. Used by
// both the settings/memory view and the tool-ui SaveMemoryCard so
// the two surfaces display the same key string.
export function prettifyKey(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
