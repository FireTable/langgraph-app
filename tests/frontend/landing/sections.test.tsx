import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Hero } from "@/components/landing/hero";
import { Features } from "@/components/landing/features";
import { Footer } from "@/components/landing/footer";
import { HowItWorks } from "@/components/landing/how-it-works";

// Marketing copy regression — the section components ship with copy
// that names each headline feature (streaming, dual-graph, memory,
// observability). A refactor that drops a title or rewrites it
// ambiguously is a bug; these tests pin the surface so the diff
// surfaces it.

describe("Hero", () => {
  afterEach(cleanup);

  it("renders the project name in the headline", () => {
    render(<Hero signedIn={false} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/langgraph app/i);
  });
});

describe("Features", () => {
  afterEach(cleanup);

  it("names every headline feature in the section heading hierarchy", () => {
    render(<Features />);
    // Each feature renders an h3 with the feature name.
    expect(screen.getByRole("heading", { name: /chat anything/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /dual-graph/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /memory/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /observability/i, level: 3 })).toBeInTheDocument();
  });
});

describe("Footer", () => {
  afterEach(cleanup);

  it("links to the GitHub repo in the project column", () => {
    render(<Footer />);
    const gh = screen.getByRole("link", { name: /^github$/i });
    expect(gh).toHaveAttribute("href", "https://github.com/FireTable/langgraph-app");
  });

  it("does not duplicate the auth CTA — header + CTA section cover it", () => {
    render(<Footer />);
    // The footer intentionally skips the "Sign in" / "Chat now"
    // button. The same affordance lives in the sticky header and
    // in the CTA section; adding it here would compete with the
    // GitHub link in the Project column one cell over.
    expect(screen.queryByRole("link", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /chat now/i })).toBeNull();
  });
});

describe("HumanInTheLoop row", () => {
  afterEach(cleanup);

  it("ships the explainer inside How-it-works", () => {
    render(<HowItWorks />);
    expect(
      screen.getByRole("heading", { name: /some tools only run with your sign-off/i, level: 3 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/human in the loop/i)).toBeInTheDocument();
  });

  it("calls out the LangGraph interrupt primitive", () => {
    render(<HowItWorks />);
    // docs/INTERRUPT.md is the canonical record — the row
    // copy must reference `interrupt()` so a marketer dropping
    // the doc link in has something to anchor onto.
    expect(screen.getByText(/interrupt\(\)/)).toBeInTheDocument();
  });
});
