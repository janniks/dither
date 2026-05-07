/**
 * Translate a plugin's `schedule` string into a croner-compatible cron pattern.
 *
 * Accepts three syntaxes:
 *
 *   every <n><unit>          e.g. "every 15m", "every 30s", "every 2h"
 *   daily at <HH>(:MM)?(am|pm)?   e.g. "daily at 9am", "daily at 14:30"
 *   <cron>                   passed through unchanged ("* / 5 * * * *", "0 9 * * 1-5", ...)
 *
 * Croner accepts both 5-field and 6-field cron (the 6-field variant adds a
 * seconds column at the front), so sub-minute schedules are fine.
 */
export function parseSchedule(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("schedule string is empty");

  const everyMatch =
    /^every\s+(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours)$/i.exec(trimmed);
  if (everyMatch) {
    const n = Number.parseInt(everyMatch[1]!, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid interval: ${trimmed}`);
    const unit = everyMatch[2]!.toLowerCase();
    if (unit.startsWith("s")) {
      if (n > 59) throw new Error(`'every ${n}s' must be ≤ 59`);
      return `*/${n} * * * * *`;
    }
    if (unit.startsWith("m")) {
      if (n > 59) throw new Error(`'every ${n}m' must be ≤ 59`);
      return `0 */${n} * * * *`;
    }
    // hours
    if (n > 23) throw new Error(`'every ${n}h' must be ≤ 23`);
    return `0 0 */${n} * * *`;
  }

  const dailyMatch = /^daily\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(trimmed);
  if (dailyMatch) {
    let hour = Number.parseInt(dailyMatch[1]!, 10);
    const minute = dailyMatch[2] ? Number.parseInt(dailyMatch[2]!, 10) : 0;
    const meridiem = dailyMatch[3]?.toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) throw new Error(`invalid hour: ${trimmed}`);
      if (meridiem === "pm" && hour !== 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
    } else if (hour < 0 || hour > 23) {
      throw new Error(`invalid hour: ${trimmed}`);
    }
    if (minute < 0 || minute > 59) throw new Error(`invalid minute: ${trimmed}`);
    return `${minute} ${hour} * * *`;
  }

  // Fall through: treat as raw cron. Croner will reject it later if invalid.
  return trimmed;
}
