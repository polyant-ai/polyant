// SPDX-License-Identifier: AGPL-3.0-or-later

export { formatDate, formatDateTime } from "@/lib/format";

export function thirtyDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
