// Vendored from https://github.com/assistant-ui/assistant-ui/tree/main/apps/docs/components/tool-ui/weather-widget
// Public barrel — import `WeatherWidget` and the runtime types from here.

export { WeatherWidget } from "./weather-widget-container";
export type {
  WeatherWidgetPayload,
  WeatherWidgetRuntimeProps as WeatherWidgetProps,
  WeatherWidgetCurrent,
  WeatherWidgetTime,
  WeatherWidgetLocation,
  WeatherConditionCode,
  ForecastDay,
  TemperatureUnit,
  PrecipitationLevel,
} from "./schema-runtime";
