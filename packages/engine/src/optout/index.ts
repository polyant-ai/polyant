// SPDX-License-Identifier: AGPL-3.0-or-later

export { runOptoutGate, type OptoutGateResult } from "./optout-gate.js";
export { getOptoutStatus, setOptoutStatus, listOptouts, type OptoutContactRow } from "./contact-optouts.store.js";
export { evaluateOptout } from "./optout.guard.js";
export type { OptoutConfig, OptoutStatus, OptoutAction } from "./optout.types.js";
