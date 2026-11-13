// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The days of a dashboard period, one entry each, for series the API returns
 * only for days that had activity.
 *
 * A day with nothing on it is absent from the API's rows; drawn as-is, a quiet
 * week collapses into a single step and a sparkline's shape lies. Every series
 * the dashboard draws over time goes through `eachDay` first.
 */

/** `yyyy-MM-dd` for a date the API sent either as that string or as a full date. */
export function dayKey(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(value).toISOString().slice(0, 10);
}

/** Every day from `from` to `to` inclusive, both `yyyy-MM-dd`. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** One value per day of the period, `fallback` where the rows have none. */
export function dailyValues<Row extends { date: string }>(
  rows: readonly Row[],
  days: readonly string[],
  pick: (row: Row) => number,
  fallback = 0,
): number[] {
  const byDay = new Map(rows.map((row) => [dayKey(row.date), row]));
  return days.map((day) => {
    const row = byDay.get(day);
    return row ? pick(row) : fallback;
  });
}

/** `1/10` for an axis tick: the day and the month, no year. */
export function dayTick(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(date)}/${Number(month)}`;
}

/**
 * The share of each day's prompt tokens read from the provider's cache, 0 to 1.
 * Null on a day that sent no prompt: a quiet day has no rate, and a zero there
 * would draw a drop that did not happen (the KPI tile's rule).
 */
export function dailyCacheHitRates(
  rows: readonly { date: string; promptTokens: number; cachedInputTokens: number }[],
  days: readonly string[],
): (number | null)[] {
  const byDay = new Map(rows.map((row) => [dayKey(row.date), row]));
  return days.map((day) => {
    const row = byDay.get(day);
    return row && row.promptTokens > 0 ? row.cachedInputTokens / row.promptTokens : null;
  });
}

/**
 * Each day's model cost divided by its turns. The cost is every model call of
 * the day (replies, service calls such as titles and summaries, embeddings,
 * failed calls the provider billed); the turns are the replies the agents gave.
 * So it reads as what one reply cost with everything around it. Null on a day
 * without turns, which has nothing to divide by.
 */
export function dailyCostPerTurn(
  costs: readonly { date: string; cost: number }[],
  turns: readonly { date: string; turns: number }[],
  days: readonly string[],
): (number | null)[] {
  const cost = dailyValues(costs, days, (row) => row.cost);
  const count = dailyValues(turns, days, (row) => row.turns);
  return days.map((_, i) => (count[i] > 0 ? cost[i] / count[i] : null));
}
