import { redirect } from "next/navigation";
import { Assistant } from "@/app/assistant";
import { getSessionFromHeaders } from "@/lib/auth/queries";

// ponytail: the dynamic route exists ONLY so refresh / share-link on
// /chat/<id> lands on a real page. Thread state is read off
// `window.location.pathname` client-side by `ThreadUrlShadow`, NOT off
// this `params.threadId` prop — passing it down would trip a runtime
// remount on every route push (issue #27 history: that double-fires
// `load()` and the adapter `fetch()`).
export default async function ChatThreadPage() {
  const session = await getSessionFromHeaders();
  if (!session) redirect("/login");
  return <Assistant />;
}
