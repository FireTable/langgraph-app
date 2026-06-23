import { Resend } from "resend";
import { render } from "react-email";
import { VerificationEmail } from "./verification-template";

const FROM = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";

// ponytail: Resend client is cheap to construct but a singleton avoids
// reconnecting on every email — we may send many in a burst.
let client: Resend | null = null;
function getClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is required to send email");
  client ??= new Resend(key);
  return client;
}

export type SendVerificationResult =
  | { ok: true }
  | { ok: false; code: "EMAIL_QUOTA_EXCEEDED" | "INTERNAL" };

export async function sendVerificationEmail({
  to,
  url,
}: {
  to: string;
  url: string;
}): Promise<SendVerificationResult> {
  try {
    const html = await render(VerificationEmail({ verificationUrl: url, userEmail: to }));
    const { error } = await getClient().emails.send({
      from: FROM,
      to,
      subject: "Verify your email",
      html,
    });
    if (error) {
      // 429 = quota; anything else is an upstream error.
      if ("statusCode" in error && error.statusCode === 429) {
        return { ok: false, code: "EMAIL_QUOTA_EXCEEDED" };
      }
      return { ok: false, code: "INTERNAL" };
    }
    return { ok: true };
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "statusCode" in e &&
      (e as { statusCode: number }).statusCode === 429
    ) {
      return { ok: false, code: "EMAIL_QUOTA_EXCEEDED" };
    }
    return { ok: false, code: "INTERNAL" };
  }
}
