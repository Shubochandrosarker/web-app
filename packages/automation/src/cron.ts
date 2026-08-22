/**
 * A five-field cron matcher: minute, hour, day-of-month, month, day-of-week.
 *
 * Supports `*`, single values, lists (`1,15`), ranges (`9-17`) and steps
 * (`10-50/10`, or `*` with `/5`). Day-of-week is 0–6 with 0 = Sunday (7
 * normalises to 0). Matching — not scheduling: the caller asks "does this fire
 * at this instant, in this time zone?", which is all a minute-granularity
 * sweep needs, and far less machinery than computing next-fire times.
 *
 * Standard cron semantics for the two day fields: when *both* are
 * restricted, either one matching fires.
 */

const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const;

interface ParsedField {
  readonly any: boolean;
  readonly values: ReadonlySet<number>;
}

function parseField(field: string, index: number): ParsedField {
  const { name, min, max } = FIELD_RANGES[index]!;
  if (field === '*') return { any: true, values: new Set() };

  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid step in cron ${name} field: "${part}"`);
    }

    let from: number;
    let to: number;
    if (rangePart === '*' || rangePart === '') {
      from = min;
      to = max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-').map(Number);
      from = a!;
      to = b!;
    } else {
      from = Number(rangePart);
      to = stepPart === undefined ? from : max;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`Invalid cron ${name} field: "${part}" (allowed ${min}–${max})`);
    }
    for (let value = from; value <= to; value += step) {
      // Cron treats both 0 and 7 as Sunday.
      values.add(index === 4 && value === 7 ? 0 : value);
    }
  }
  return { any: false, values };
}

export interface ParsedCron {
  readonly minute: ParsedField;
  readonly hour: ParsedField;
  readonly dayOfMonth: ParsedField;
  readonly month: ParsedField;
  readonly dayOfWeek: ParsedField;
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `A cron expression has five fields (minute hour day month weekday); got "${expression}".`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) =>
    parseField(field, index),
  );
  return {
    minute: minute!,
    hour: hour!,
    dayOfMonth: dayOfMonth!,
    month: month!,
    dayOfWeek: dayOfWeek!,
  };
}

const WEEKDAY_NUMBERS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Does `expression` fire at `instant`, read in `timeZone`? */
export function cronMatches(expression: string, instant: Date, timeZone: string): boolean {
  const cron = parseCron(expression);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';

  const minute = Number(get('minute'));
  const hour = Number(get('hour'));
  const dayOfMonth = Number(get('day'));
  const month = Number(get('month'));
  const dayOfWeek = WEEKDAY_NUMBERS[get('weekday')] ?? -1;

  if (!cron.minute.any && !cron.minute.values.has(minute)) return false;
  if (!cron.hour.any && !cron.hour.values.has(hour)) return false;
  if (!cron.month.any && !cron.month.values.has(month)) return false;

  // Standard cron: when both day fields are restricted, either may match.
  const domMatches = cron.dayOfMonth.any || cron.dayOfMonth.values.has(dayOfMonth);
  const dowMatches = cron.dayOfWeek.any || cron.dayOfWeek.values.has(dayOfWeek);
  if (!cron.dayOfMonth.any && !cron.dayOfWeek.any) return domMatches || dowMatches;
  return domMatches && dowMatches;
}
