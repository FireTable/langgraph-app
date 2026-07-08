import "@testing-library/jest-dom/vitest";

// ponytail: jsdom doesn't ship IntersectionObserver, but motion's
// `useInView` reads it on mount and crashes the test. Stub a
// no-op observer so the four motion demos (which all gate
// animation on in-view) can render without throwing.
if (typeof IntersectionObserver === "undefined") {
  class StubIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  // ponytail: cast through `unknown` — jsdom typings treat
  // `IntersectionObserver` as the concrete class; assigning a
  // matching shape to the global is the standard workaround.
  globalThis.IntersectionObserver =
    StubIntersectionObserver as unknown as typeof IntersectionObserver;
}
