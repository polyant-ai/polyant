// SPDX-License-Identifier: AGPL-3.0-or-later

import "@testing-library/jest-dom/vitest";

// jsdom does not implement the pointer-capture or scroll APIs that Radix UI
// primitives (Select, etc.) call on open. Polyfill them as no-ops so those
// components can be driven in component tests.
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

// Radix relies on ResizeObserver, which jsdom does not provide.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// The panel follows the browser language when no locale is stored. Tests
// assert the Italian copy, so pin the browser to Italian; the i18n context
// tests override this where they exercise detection.
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "languages", {
    value: ["it-IT", "it"],
    configurable: true,
  });
  Object.defineProperty(navigator, "language", {
    value: "it-IT",
    configurable: true,
  });
}
