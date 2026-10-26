// SPDX-License-Identifier: AGPL-3.0-or-later

import { translate } from "@/lib/i18n/context";
import { instanceStatusLabel } from "./instance-status";

const t = (key: Parameters<typeof translate>[1]) => translate("it", key);

describe("instanceStatusLabel", () => {
  it("shows the stored English status in Italian", () => {
    // Catches the raw "active" badge on the agents list, header and Status tab.
    expect(instanceStatusLabel("active", t)).toBe("Attivo");
    expect(instanceStatusLabel("inactive", t)).toBe("Inattivo");
  });

  it("prints an unknown status as stored", () => {
    expect(instanceStatusLabel("archived", t)).toBe("archived");
  });
});
