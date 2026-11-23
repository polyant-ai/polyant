// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { render, screen } from "@testing-library/react";
import { assertNoActWarnings } from "./test-act-guard";

/** Changes its state a moment after mounting, as a component that loads something does. */
function LateCounter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setCount(1), 0);
    return () => clearTimeout(timer);
  }, []);
  return <span>count:{count}</span>;
}

describe("the act guard in test-setup", () => {
  // Catches a guard that stopped seeing React's warning (its wording changed, or
  // console.error is no longer watched): unsettled tests would pass again.
  it("fails a test whose component changed state after the test stopped waiting, naming it", async () => {
    render(<LateCounter />);
    // A plain wait, outside anything React or Testing Library knows about.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Checked here, so the afterEach this test is about finds nothing left to fail on.
    expect(assertNoActWarnings).toThrow(/outside act\(\) in LateCounter/);
  });

  it("lets a test that waits for the state it checks pass", async () => {
    render(<LateCounter />);
    expect(await screen.findByText("count:1")).toBeInTheDocument();
    expect(assertNoActWarnings).not.toThrow();
  });
});
