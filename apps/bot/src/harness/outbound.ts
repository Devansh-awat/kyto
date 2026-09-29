// One hook every piece of text kyto sends to Slack passes through, installed by
// the app at boot (lib/redact). It lives here, not in lib/, because the harness
// must not import app code — the app hands it a function instead.
//
// Identity by default, so a harness used without the app (tests) sends text
// exactly as given.

type TextFilter = (text: string) => string;

let filter: TextFilter = (text) => text;

export function setOutboundFilter(next: TextFilter): void {
  filter = next;
}

export function filterOutbound(text: string): string {
  return filter(text);
}

/**
 * Every string inside plain objects and arrays, e.g. Block Kit blocks or a task
 * card chunk. Anything that is not a plain object (a Uint8Array, a Date) is
 * passed through untouched — walking one would turn it into `{}`.
 */
export function filterOutboundDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return filter(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => filterOutboundDeep(item)) as T;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        filterOutboundDeep(item),
      ])
    ) as T;
  }
  return value;
}
