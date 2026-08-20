import type { AutomationCondition, Predicate } from './definition.ts';

/**
 * Condition evaluation.
 *
 * Pure and synchronous on purpose: an automation's branching must be
 * reproducible from a stored run context when replaying or debugging a run,
 * which rules out conditions that go and fetch things.
 */

export type RunContext = Readonly<Record<string, unknown>>;

/** Read a dot path out of the run context. Missing segments yield undefined. */
export function readPath(context: RunContext, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function evaluatePredicate(context: RunContext, predicate: Predicate): boolean {
  const actual = readPath(context, predicate.path);
  const expected = predicate.value;

  switch (predicate.comparator) {
    case 'is_set':
      return actual !== undefined && actual !== null && actual !== '';
    case 'is_not_set':
      return actual === undefined || actual === null || actual === '';
    case 'equals':
      return looseEquals(actual, expected);
    case 'not_equals':
      return !looseEquals(actual, expected);
    case 'contains':
      return containsValue(actual, expected);
    case 'not_contains':
      return !containsValue(actual, expected);
    case 'starts_with':
      return (
        typeof actual === 'string' && typeof expected === 'string' && actual.startsWith(expected)
      );
    case 'greater_than':
      return compareNumbers(actual, expected, (a, b) => a > b);
    case 'less_than':
      return compareNumbers(actual, expected, (a, b) => a < b);
    case 'in':
      return (
        Array.isArray(expected) && expected.some((candidate) => looseEquals(actual, candidate))
      );
    case 'not_in':
      return !(
        Array.isArray(expected) && expected.some((candidate) => looseEquals(actual, candidate))
      );
  }
}

export function evaluateCondition(context: RunContext, condition: AutomationCondition): boolean {
  const results = condition.predicates.map((predicate) => evaluatePredicate(context, predicate));
  return condition.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Values arrive from JSON, form posts and webhooks, so `"5"` and `5` routinely
 * mean the same thing. Comparison coerces across string/number but never
 * treats null and 0 — or an empty string and false — as equal.
 */
function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined)
    return false;

  if (typeof actual === 'number' && typeof expected === 'string')
    return String(actual) === expected;
  if (typeof actual === 'string' && typeof expected === 'number')
    return actual === String(expected);

  return false;
}

function containsValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase().includes(expected.toLowerCase());
  }
  if (Array.isArray(actual)) return actual.some((item) => looseEquals(item, expected));
  return false;
}

function compareNumbers(
  actual: unknown,
  expected: unknown,
  compare: (a: number, b: number) => boolean,
): boolean {
  const left = toNumber(actual);
  const right = toNumber(expected);
  if (left === null || right === null) return false;
  return compare(left, right);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
