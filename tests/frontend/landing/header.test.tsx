import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Header } from "@/components/landing/header";

// Header — sticky nav with brand, anchor links, GitHub repo link,
// and an auth-aware CTA on the right. The CTA is the same
// HeroCta primitive the hero uses; signedIn drives its label + href.

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

  it("renders a 'Sign in' CTA pointing at /login when signed out", () => {
    render(<Header signedIn={false} />);
    const cta = screen.getByRole("link", { name: /sign in/i });
    expect(cta).toHaveAttribute("href", "/login");
  });

  it("renders an 'Open chat' CTA pointing at /chat when signed in", () => {
    render(<Header signedIn={true} />);
    const cta = screen.getByRole("link", { name: /open chat/i });
    expect(cta).toHaveAttribute("href", "/chat");
  });

  it("falls back to the signed-out CTA while the session is loading", () => {
    render(<Header signedIn={null} />);
    const cta = screen.getByRole("link", { name: /sign in/i });
    expect(cta).toHaveAttribute("href", "/login");
  });
});
