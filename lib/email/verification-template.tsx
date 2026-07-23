// Upstream: github.com/resend/react-email (MIT); Adapted for 001-user-auth.
// Forked from apps/demo/emails/02-Matte/activation.tsx on the canary branch;
// the footer social row + address block is dropped because verification
// emails should be quiet, and the image path is rewritten to /email/...

import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Img,
  Preview,
  Section,
  Tailwind,
  Text,
} from "react-email";
import { CollageFonts } from "./collage-fonts";
import { collageTailwindConfig } from "./theme";

interface VerificationEmailProps {
  verificationUrl: string;
  userEmail: string;
  // Absolute origin for static assets. Email clients don't resolve
  // relative URLs the way browsers do — `/email/...` would 404 in
  // Gmail / Outlook. We prepend it here so the rendered <Img src>
  // is a fully-qualified https URL.
  baseUrl: string;
}

export const VerificationEmail = ({
  verificationUrl,
  userEmail,
  baseUrl,
}: VerificationEmailProps) => (
  <Tailwind config={collageTailwindConfig}>
    <Html>
      <Head>
        <CollageFonts />
      </Head>
      <Body className="bg-canvas font-14 font-inter text-fg m-0 p-0">
        <Preview>Verify your email address</Preview>
        <Container className="mx-auto max-w-[640px] px-4 pt-16 pb-6">
          <Section className="shadow-collage-card rounded-[8px]">
            <Section className="bg-bg border-stroke rounded-[8px] border">
              <Section className="mobile:px-6! px-10 pt-16">
                <Img
                  src={`${baseUrl}/email/logo.png`}
                  alt="LangGraph App Logo"
                  width={120}
                  height={120}
                  className="block border-none"
                />
              </Section>

              <Section className="mobile:px-6! px-10 pt-8">
                <Section className="mb-9">
                  <Text className="font-48 text-fg m-0 font-sans">Verify your email</Text>
                  <Text className="font-14 font-inter text-fg-2 m-0 mt-[18px]">
                    We received a sign-up attempt for {userEmail}.
                  </Text>
                  <Text className="font-14 font-inter text-fg-2 m-0">
                    Click the button below to confirm and finish setting up your account.
                  </Text>
                </Section>

                <Button
                  href={verificationUrl}
                  className="bg-brand font-15 font-inter text-fg-inverted inline-block border-none px-5 py-3.5 text-center"
                >
                  Verify email
                </Button>
              </Section>

              <Section className="mobile:px-6! px-10 pt-16 pb-16">
                <Text className="font-11 font-inter text-fg-3 m-0 max-w-[310px]">
                  If you didn&apos;t request this, you can safely ignore this email — no account
                  will be created.
                </Text>
              </Section>
            </Section>
          </Section>
        </Container>
      </Body>
    </Html>
  </Tailwind>
);

VerificationEmail.PreviewProps = {
  verificationUrl: "https://example.com/verify?token=demo",
  userEmail: "user@example.com",
  baseUrl: "https://example.com",
} satisfies VerificationEmailProps;

export default VerificationEmail;
