// SPDX-License-Identifier: AGPL-3.0-or-later

import "@testing-library/jest-dom/vitest";
import { loadCatalog } from "@/lib/i18n/catalogs";

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

// The panel loads each language's strings on demand and the provider waits for
// them. Tests render many providers synchronously, so both catalogues are loaded
// once, up front.
await Promise.all([loadCatalog("en"), loadCatalog("it")]);
