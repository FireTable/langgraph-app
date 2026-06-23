import { redirect } from "next/navigation";
import { Assistant } from "@/app/assistant";
import { getSessionFromHeaders } from "@/lib/auth/queries";

export default async function ChatPage() {
  const session = await getSessionFromHeaders();
  if (!session) redirect("/login");
  return <Assistant />;
}
