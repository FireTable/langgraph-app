import { headers } from "next/headers";
import { auth } from "./config";

export async function getSessionFromHeaders() {
  return auth.api.getSession({ headers: await headers() });
}
