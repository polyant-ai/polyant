// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * React logs "An update to X inside a test was not wrapped in act(...)" when a
 * component's state changes after the test stopped looking: the test asserted
 * before the screen settled, so it may have checked a state the user never
 * sees. The guard collects those warnings and fails the test that produced
 * them. The fix is in the test: wait for the state it means to check
 * (`findBy*`, `waitFor`), or drive an update from outside React through `act`.
 */

const warnings: string[] = [];

/** Watches console.error for React's act warning and fails the test after it. */
export function installActGuard(): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("not wrapped in act(")) {
      // React passes the component's name as the format argument.
      warnings.push(typeof args[1] === "string" ? args[1] : "a component");
    }
    original(...args);
  };
  afterEach(assertNoActWarnings);
}

/** Throws, naming the components, when an act warning was logged since the last check. */
export function assertNoActWarnings(): void {
  if (warnings.length === 0) return;
  const components = [...new Set(warnings.splice(0))].join(", ");
  throw new Error(
    `React state changed outside act() in ${components}: wait for the state the test checks (findBy*, waitFor) before it ends.`,
  );
}
