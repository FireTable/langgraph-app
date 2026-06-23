import { fetchUrl } from "@/backend/tool/web-fetch";
import { searchWeb } from "@/backend/tool/web-search";

// ponytail: keep the tool list in one place so the graph binds it from a
// single source. Adding a tool = drop a file + add one line here.

export const TOOLS = [fetchUrl, searchWeb];

export { fetchUrl, searchWeb };
