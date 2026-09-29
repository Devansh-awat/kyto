// A backstop, ported from coolton (owner's ask, 2026-09-29): strip the actual
// VALUE of every secret kyto holds out of anything headed to Slack or back into
// the model.
//
// kyto's real defence is structural — a secret never attaches to a request it
// doesn't belong on (the GitHub and Slack proxies, `getFile`'s host check, no
// credential in the sandbox). This catches what that design never anticipated:
// a secret that turns up VERBATIM in a tool result or a reply. It is exact-match
// only, so a secret that was base64'd or split first gets through; that is why
// it is a backstop and not the defence.
//
// When it fires, the owner is told WHICH secret and WHERE — never the value.

// An env var whose NAME says it is a secret. DATABASE_URL carries the password.
const SECRET_NAME =
  /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|SIGNING|COOKIE|DATABASE_URL/i;

// Anything shorter is too likely to be an ordinary word or number that happens
// to also be some flag's value ("true", "3000").
const MIN_SECRET_LENGTH = 12;

// How often the owner may be DM'd about the same secret — one leak attempt tends
// to repeat on every step of a turn.
const ALERT_EVERY_MS = 60 * 60 * 1000;

// Secrets that never touch the environment: a person's own model key or a
// ChatGPT token, known only once decrypted for a turn.
const runtime = new Map<string, string>();

let fromEnv: [label: string, value: string][] | undefined;

function envSecrets(): [string, string][] {
  fromEnv ??= Object.entries(process.env).flatMap(([name, value]) =>
    value && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name)
      ? [[name, value] as [string, string]]
      : []
  );
  return fromEnv;
}

/** Remember a secret that only exists at runtime (e.g. a decrypted user key). */
export function registerSecret({
  label,
  value,
}: {
  label: string;
  value: string;
}): void {
  if (value.length >= MIN_SECRET_LENGTH) {
    runtime.set(value, label);
  }
}

// Called on EVERY catch with `fresh` = the labels not already reported within
// the hour, so the installer can log each one and DM only the fresh ones. This
// module deliberately imports nothing (tests load it without an environment).
type AlertFn = (hit: {
  context: string;
  fresh: string[];
  labels: string[];
}) => void;

let alert: AlertFn | undefined;
const lastAlertAt = new Map<string, number>();

/** Installed at boot: how to tell the owner a secret was caught. */
export function setRedactionAlert(fn: AlertFn): void {
  alert = fn;
}

/**
 * `text` with every known secret value replaced by `[redacted NAME]`. `context`
 * says where it was caught, for the log and the owner's DM.
 */
export function redactSecrets(text: string, context: string): string {
  if (text.length < MIN_SECRET_LENGTH) {
    return text;
  }
  let out = text;
  const labels: string[] = [];
  const candidates: [string, string][] = [
    ...envSecrets(),
    ...[...runtime].map(([value, label]): [string, string] => [label, value]),
  ];
  for (const [label, value] of candidates) {
    if (out.includes(value)) {
      out = out.replaceAll(value, `[redacted ${label}]`);
      labels.push(label);
    }
  }
  if (labels.length > 0) {
    report({ context, labels });
  }
  return out;
}

/**
 * The same over every string in plain objects and arrays — a tool's result.
 * Anything that is not a plain object (bytes, a Date) is left as it is.
 */
export function redactSecretsDeep<T>(value: T, context: string): T {
  if (typeof value === 'string') {
    return redactSecrets(value, context) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, context)) as T;
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactSecretsDeep(item, context),
      ])
    ) as T;
  }
  return value;
}

function report({
  context,
  labels,
}: {
  context: string;
  labels: string[];
}): void {
  const now = Date.now();
  const fresh = labels.filter(
    (label) => now - (lastAlertAt.get(label) ?? 0) > ALERT_EVERY_MS
  );
  for (const label of fresh) {
    lastAlertAt.set(label, now);
  }
  alert?.({ context, fresh, labels });
}
