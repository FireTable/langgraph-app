import { redirect } from "next/navigation";

// ponytail: UserButton's default Settings link is `${basePaths.settings}` —
// when basePaths.settings is "/settings" (no trailing segment) the link
// lands on /settings itself, not /settings/account. Better-auth-ui's
// <Settings> throws on a missing path, so we redirect to the canonical
// first tab instead of letting the user see a 500.
export default function SettingsIndexPage(): never {
  redirect("/settings/account");
}
