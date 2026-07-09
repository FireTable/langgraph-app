import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Header } from "@/components/landing/header";

// Header — sticky nav with brand, anchor links, GitHub repo link,
// and a CTA on the right. The CTA is the same HeroCta primitive
// the hero uses; copy is "Chat now" for everyone, signedIn drives
// only the href (signed-in → /chat, anon / null → /login bounce).

const REPO_URL = "https://github.com/FireTable/langgraph-app";

describe("Header", () => {
  afterEach(cleanup);

  it("renders the brand link to /", () => {
    render(<Header signedIn={false} />);
    const brand = screen.getByRole("link", { name: /langgraph app — home/i });
    expect(brand).toHaveAttribute("href", "/");
  });

  it("renders anchor links to each marketing section", () => {
    render(<Header signedIn={false} />);
    expect(screen.getByRole("link", { name: "Features" })).toHaveAttribute("href", "#features");
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute(
      "href",
      "#how-it-works",
    );
    expect(screen.getByRole("link", { name: "Self-host" })).toHaveAttribute("href", "#self-host");
  });

  it("renders a GitHub link to the public repo", () => {
    render(<Header signedIn={false} />);
    const gh = screen.getByRole("link", { name: /on github/i });
    expect(gh).toHaveAttribute("href", REPO_URL);
  });

  it("renders a 'Chat now' CTA pointing at /login when signed out", () => {
    render(<Header signedIn={false} />);
    const cta = screen.getByRole("link", { name: /chat now/i });
    expect(cta).toHaveAttribute("href", "/login");
  });

  it("renders a 'Chat now' CTA pointing at /chat when signed in", () => {
    render(<Header signedIn={true} />);
    const cta = screen.getByRole("link", { name: /chat now/i });
    expect(cta).toHaveAttribute("href", "/chat");
  });

  it("falls back to the signed-out CTA while the session is loading", () => {
    render(<Header signedIn={null} />);
    const cta = screen.getByRole("link", { name: /chat now/i });
    expect(cta).toHaveAttribute("href", "/login");
  });
});
