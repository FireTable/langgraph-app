import { redirect } from "next/navigation";
import { getSessionFromHeaders } from "@/lib/auth/queries";

export default async function Home() {
  const session = await getSessionFromHeaders();
  redirect(session ? "/chat" : "/login");
}
