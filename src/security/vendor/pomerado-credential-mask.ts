// Vendored from Pomerado (https://github.com/Pomerado/pomerado), typescript/src/runtime/failure-detail.ts (lines 206-517: the text redaction core only; the Effect-based failure records are left out).
// MIT License, Copyright (c) 2026 Pomerado AI, Inc. — full text in third-party/pomerado/LICENSE.
// biome-ignore-all lint: kept as upstream wrote it

import {
  authorizationCredential,
  awsAccessKeyIdPattern,
  bracketedValueSource,
  cookieCredentials,
  credentialNameSource,
  credentialPolicy,
  isCredentialAssignmentKey,
  isFreeTextSchemeCredential,
  isKeptAssignmentValue,
  isLiteralValue,
  isOrdinaryWord,
  isProviderKey,
  providerKeyPattern,
} from "./pomerado-credential-policy.js";
import { isSecretKey } from "./pomerado-secret-keys.js";
import { type UrlSpan, urlReaches, urlSpanAt, urlSpans } from "./pomerado-url-spans.js";

/**
 * Generous bounds that keep a record storable (one archive object, one log line well under
 * CloudWatch's 256 KiB event limit), never a cut to hide detail.
 */
const bounds = {
  message: 16 * 1024,
  chainMessage: 8 * 1024,
  chainDepth: 8,
  stackFrames: 48,
  frameLength: 1024,
  contextKeys: 128,
  contextValue: 16 * 1024,
  fieldValue: 4 * 1024,
  commands: 128,
  serialized: 128 * 1024,
} as const;
export const failureDetailBounds = bounds;

/** A route at the start of the text (`/v1/items?page=2`) is kept like a URL, ending as one does. */
const diagnosticUrlSpans = (text: string) => {
  const spans = urlSpans(text);
  if (!text.startsWith("/") || text.startsWith("//")) return spans;
  const route = urlSpanAt(text, 0);
  return [route, ...spans.filter((span) => span.start >= route.end)];
};

/**
 * What releases before URLs ended at field delimiters kept as URLs: each URL to the next space or
 * quote, and a leading route to the first space or quote. Sorted, and never a screening exemption.
 */
const legacyUrlSpans = (text: string): UrlSpan[] => {
  const reaches = urlReaches(text);
  if (!text.startsWith("/")) return reaches;
  const separator = text.search(/[\s"'<>`]/);
  const routeEnd = separator === -1 ? text.length : separator;
  return [{ start: 0, end: routeEnd }, ...reaches.filter((span) => span.start >= routeEnd)];
};

const withoutUrls = (text: string) => {
  let result = "";
  let cursor = 0;
  for (const span of diagnosticUrlSpans(text)) {
    result += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return result + text.slice(cursor);
};

/**
 * The length of `text` outside its URLs, for the stored bounds. A URL is also measured as releases
 * before URLs ended at field delimiters measured it, so a record such a release bounded still
 * decodes.
 */
const lengthOutsideUrls = (text: string) => {
  const spans = diagnosticUrlSpans(text).concat(legacyUrlSpans(text));
  spans.sort((left, right) => left.start - right.start);
  let inside = 0;
  let covered = 0;
  for (const span of spans) {
    inside += Math.max(0, span.end - Math.max(span.start, covered));
    covered = Math.max(covered, span.end);
  }
  return text.length - inside;
};

const limitOutsideUrls = (text: string, max: number, tokenBoundary = false) => {
  if (text.length <= max) return { value: text, omitted: 0 };
  let value = "";
  let cursor = 0;
  let remaining = max;
  let omitted = 0;
  // The last character appended, kept apart: reading it from `value`, a string built by `+=`,
  // flattens that string each time, which is quadratic over many URLs.
  let last = "";
  const append = (piece: string) => {
    value += piece;
    if (piece !== "") last = piece.charAt(piece.length - 1);
  };
  const appendPlain = (plain: string) => {
    if (remaining >= plain.length) {
      append(plain);
      remaining -= plain.length;
      return;
    }
    const end = /[\uD800-\uDBFF]/.test(plain.charAt(remaining - 1)) ? remaining - 1 : remaining;
    const prefix = tokenBoundary ? plain.slice(0, end).replace(/\S*$/, "") : plain.slice(0, end);
    append(prefix);
    omitted += plain.length - prefix.length;
    remaining = 0;
  };
  // A URL's characters an older release would not count as URL, such as a balanced closer it
  // trimmed, are charged to the budget, so the result still fits that release's bound.
  const legacy = legacyUrlSpans(text);
  let next = 0;
  const outsideLegacy = (span: UrlSpan) => {
    while (next < legacy.length && (legacy[next]?.end ?? 0) <= span.start) next++;
    let inside = 0;
    for (let index = next; index < legacy.length; index++) {
      const range = legacy[index];
      if (range === undefined || range.start >= span.end) break;
      inside += Math.min(range.end, span.end) - Math.max(range.start, span.start);
    }
    return span.end - span.start - inside;
  };
  for (const span of diagnosticUrlSpans(text)) {
    appendPlain(text.slice(cursor, span.start));
    remaining = Math.max(0, remaining - outsideLegacy(span));
    if (omitted > 0 && last !== "" && !/\s/.test(last)) append(" ");
    append(text.slice(span.start, span.end));
    cursor = span.end;
  }
  appendPlain(text.slice(cursor));
  return { value, omitted };
};

const truncate = (text: string, max: number) => {
  const limited = limitOutsideUrls(text, max);
  return limited.omitted === 0 ? limited.value : `${limited.value}…[truncated ${limited.omitted}]`;
};

/**
 * A credential name (`privacy/credential-policy.ts`), quoted or bare and with any prefix,
 * followed by `=` or `:`. The key's word boundary is checked by `isCredentialAssignmentKey`.
 * After `=` a bracketed value (`password=[…]`) is one credential; after `:` a bracket opens a
 * JSON container, whose own leaves are screened where they are.
 */
const credentialAssignment = new RegExp(
  String.raw`([,;|\s"'{()\]]|^)((?:[A-Za-z0-9]+[-_])*[A-Za-z0-9]*(?:${credentialNameSource}))(\\?["']?\s*[=:]\s*)(${bracketedValueSource}|\\?"(?:\\.|[^"\\])*\\?"|\\?"(?:\\.|[^"\\\r\n])*\\?|'[^']*'|[^\s;,"')}][^\s;,"')}]*)`,
  "gi",
);
/** A Key Vault or Secrets Manager response holds the secret itself under `value`. */
const vaultResponse =
  /\.vault\.azure\.net|"SecretString"|secretsmanager|"contentType"\s*:\s*"[^"]*"\s*,\s*"id"/i;
const vaultValue = /(\\?")(value)(\\?"\s*:\s*)(\\"(?:(?!\\").)*\\"|"(?:\\.|[^"\\])*")/gi;
/** Largest non-URL input redacted; whole URLs are retained even beyond this bound. */
const redactionInputLimit = 64 * 1024;
/**
 * JSON fields that carry request credentials or vault secrets, including escaped JSON. A header
 * field holding one ordinary word (`"cookie":"accepted"`) is not a credential.
 */
const jsonCredential = new RegExp(
  String.raw`(\\?")(${[...credentialPolicy.jsonHeaderFields, ...credentialPolicy.vaultFields].join("|")})(\\?"\s*:\s*)(\\"(?:(?!\\").)*\\"|"(?:\\.|[^"\\])*"|"(?:\\.|[^"\\\r\n])*\\?)`,
  "gi",
);
const vaultField = new RegExp(`^(?:${credentialPolicy.vaultFields.join("|")})$`, "i");
const jsonCredentialValue = (key: string, value: string) => {
  const content = value.replace(/^\\?"|\\?"$/g, "");
  return vaultField.test(key) || (content !== "" && !isOrdinaryWord(content));
};
/**
 * Cookie header text: `Cookie: a=1; b=2`, `cookie: 'a=1'`, `Cookie a=1` or
 * `Set-Cookie: s=1; Path=/`, including quoted values and a comma-joined Set-Cookie
 * (`credential-policy.ts` `cookieCredentials`). Only the `name=value` run, or an opaque value
 * after `:`, is masked, so `cookie: invalid format` is prose.
 */
const cookieHeader = /\b(set-cookie|cookie)(\s*:\s*["']?|\s+)([^\r\n]*)/gi;
/** `cookie=value` outside a URL, unless the value is one ordinary word (`cookie=accepted`). */
const cookieAssignment = /\b(set-cookie|cookie)(\s*=\s*)([^\s;,"'&]+)/gi;
/**
 * Header text runs to the line end, a quote or a backslash (`authorization: 'Bearer …'` from
 * `util.inspect` included), keeping quoted auth-param values (`Digest response="…"`); only its
 * credential is masked.
 */
const authorizationHeader =
  /\b((?:proxy-)?authorization)(\s*[:=]\s*["']?)((?:[^\r\n"'\\]|(?<==[ \t]*)"[^"\r\n]*")*)/gi;
const quotedRedaction = (value: string) =>
  value.startsWith("\\") ? '\\"[redacted]\\"' : '"[redacted]"';
/** AWS access key IDs and provider API keys, by shape (`privacy/credential-policy.ts`). */
const awsAccessKeyId = awsAccessKeyIdPattern();
const providerKey = providerKeyPattern();

/**
 * Deterministic credential redaction before the archive's own screening. It removes only
 * real credentials: password-style and credential-named assignments, Authorization, Cookie
 * and Set-Cookie headers, bearer and basic values, JWTs, PEM private keys, provider API-key
 * shapes and vault secret values. Every URL stays byte-exact
 * (`privacy/url-spans.ts` locates them), and ordinary
 * names such as `token` or `auth` keep their values. Values are matched by shape
 * (`privacy/credential-policy.ts`), so prose such as "basic validation failed",
 * `password: required` or `authorization: missing for this route` is kept.
 */
export const redactDiagnosticText = (text: string, max: number = bounds.message): string =>
  // A caller that keeps the whole text (no output limit) gets the whole text screened, in chunks;
  // a bounded caller only ever needs the start, so its input is cut before redaction.
  max === Number.POSITIVE_INFINITY && text.length > redactionInputLimit
    ? redactInChunks(text)
    : redactBounded(text, max, redactionInputLimit);

/** Ends of the private-key block that starts before `end`, when it does not finish by then. */
const privateKeyEnd = (text: string, start: number, end: number): number | undefined => {
  const blocks = text.slice(start, end);
  const open = blocks.lastIndexOf("-----BEGIN ");
  if (open === -1 || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(blocks.slice(open)))
    return undefined;
  if (/-----END [A-Z ]*PRIVATE KEY-----/.test(blocks.slice(open))) return undefined;
  const close = /-----END [A-Z ]*PRIVATE KEY-----/.exec(text.slice(end));
  return close === null ? text.length : end + close.index + close[0].length;
};

/**
 * Screens text of any length without cutting it: chunks that end at whitespace, so no token is
 * split, and never inside a private-key block, which is screened whole.
 */
const redactInChunks = (text: string): string => {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + redactionInputLimit);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(" ", end),
        text.lastIndexOf("\t", end),
      );
      if (boundary > start) end = boundary + 1;
      else {
        // A credential assignment may be one very long token. Keep its entire value in one
        // screening pass; later chunks would otherwise lose the credential key before it.
        const nextWhitespace = /[ \t\r\n]/gu;
        nextWhitespace.lastIndex = end;
        const next = nextWhitespace.exec(text);
        end = next === null ? text.length : next.index + 1;
      }
      end = privateKeyEnd(text, start, end) ?? end;
    }
    parts.push(
      redactBounded(text.slice(start, end), Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    );
    start = end;
  }
  return parts.join("");
};

const redactBounded = (text: string, max: number, inputLimit: number): string => {
  // A cut can split a token so its pattern no longer matches, so the trailing partial word
  // is removed with the cut, and redaction always runs before the output is truncated.
  const input = limitOutsideUrls(text, inputLimit, true).value;
  // URLs are set aside so no credential rule rewrites them.
  const urls: string[] = [];
  let protectedText = "";
  let cursor = 0;
  for (const span of diagnosticUrlSpans(input)) {
    protectedText += `${input.slice(cursor, span.start)}\uE000${urls.length}\uE000`;
    urls.push(input.slice(span.start, span.end));
    cursor = span.end;
  }
  protectedText += input.slice(cursor);
  const redacted = (
    vaultResponse.test(input)
      ? protectedText.replace(
          vaultValue,
          (_match, open: string, key: string, separator: string, value: string) =>
            `${open}${key}${separator}${quotedRedaction(value)}`,
        )
      : protectedText
  )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted_private_key]",
    )
    .replace(
      jsonCredential,
      (match: string, open: string, key: string, separator: string, value: string) =>
        jsonCredentialValue(key, value)
          ? `${open}${key}${separator}${quotedRedaction(value)}`
          : match,
    )
    .replace(
      authorizationHeader,
      (match: string, name: string, separator: string, value: string) => {
        const credential = authorizationCredential(value);
        return credential === undefined
          ? match
          : `${name}${separator}${value.slice(0, credential.start)}[redacted]${value.slice(credential.end)}`;
      },
    )
    .replace(cookieHeader, (match: string, name: string, separator: string, value: string) => {
      const cookie = cookieCredentials(value, /^set-/i.test(name));
      if (cookie === undefined) return match;
      const run = value.slice(cookie.run.start, cookie.run.end);
      // Without a colon (`Cookie a=1`), only a leading unspaced name=value pair is a header, so
      // prose such as `cookie count = 3` stays.
      if (!separator.includes(":") && (cookie.run.start > 0 || !/^[^\s=;,"'\\]+=/.test(run)))
        return match;
      return `${name}${separator}${value.slice(0, cookie.run.start)}[redacted]${value.slice(cookie.run.end)}`;
    })
    .replace(cookieAssignment, (match: string, name: string, separator: string, value: string) =>
      value.startsWith("[redacted") || isOrdinaryWord(value) || isLiteralValue(value)
        ? match
        : `${name}${separator}[redacted]`,
    )
    .replace(
      /\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]+)/gi,
      (match: string, scheme: string, space: string, value: string) =>
        isFreeTextSchemeCredential(scheme, value) ? `${scheme}${space}[redacted]` : match,
    )
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "[redacted_jwt]")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}(?=\s*$)/g, "[redacted_jwt]")
    .replace(awsAccessKeyId, "[redacted_aws_key]")
    .replace(providerKey, (match: string) =>
      isProviderKey(match) ? "[redacted_token]" : match,
    )
    .replace(
      credentialAssignment,
      (match: string, prefix: string, key: string, separator: string, value: string) =>
        value.startsWith("[redacted") ||
        !isCredentialAssignmentKey(key) ||
        isKeptAssignmentValue(key, separator, value, input)
          ? match
          : `${prefix}${key}${separator}[redacted]`,
    )
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => urls[Number(index)] ?? "");
  return truncate(redacted, max);
};

/** The error beneath a failure: Chromium `{code,message}`, a pg SQLSTATE, an AWS error name. */
