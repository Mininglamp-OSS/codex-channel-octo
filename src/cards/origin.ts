/**
 * Canonical API origin identity for card REST traffic.
 *
 * `normalizeOrigin` produces the timing identity shared by the process-wide
 * pacer: lower-case scheme, IDNA lower-case host and effective port, with
 * userinfo/path/query/fragment excluded. `parseApiBase` additionally retains
 * the configured REST base path, which is never part of the origin identity.
 *
 * Both fail closed: userinfo, control characters, backslashes, whitespace,
 * unsupported schemes and anything the existing allowed-origin SSRF policy
 * (`isAllowedApiUrl`) rejects throw an `OriginPolicyError`. Errors carry a
 * closed code only and never echo the rejected input.
 */

import { isAllowedApiUrl } from "../url-policy.js";

export type OriginScheme = "https" | "http";

export interface NormalizedOrigin {
  readonly scheme: OriginScheme;
  /** IDNA (punycode) lower-case host; IPv6 literals keep their brackets. */
  readonly host: string;
  /** Effective port; the scheme default is made explicit. */
  readonly port: number;
  /** `scheme://host:port` — the only value used as an origin identity key. */
  readonly key: string;
}

export interface ApiBase {
  readonly origin: NormalizedOrigin;
  /** `""` or `/seg[/seg...]` without a trailing slash. */
  readonly basePath: string;
}

export type OriginPolicyErrorCode =
  | "invalid_url"
  | "unsafe_characters"
  | "userinfo"
  | "unsupported_scheme"
  | "invalid_host"
  | "invalid_port"
  | "invalid_path"
  | "query_or_fragment"
  | "disallowed_origin";

export class OriginPolicyError extends Error {
  readonly code: OriginPolicyErrorCode;
  constructor(code: OriginPolicyErrorCode) {
    super(`card api origin rejected: ${code}`);
    this.name = "OriginPolicyError";
    this.code = code;
  }
}

const MAX_URL_LENGTH = 2048;
const DEFAULT_PORTS: Readonly<Record<OriginScheme, number>> = { https: 443, http: 80 };

// C0 controls, DEL, C1 controls, whitespace, backslash, and bidi/zero-width
// format characters that could make the displayed and parsed URL differ.
const UNSAFE_URL_CHARS = /[\u0000-\u0020\u007f-\u009f\\\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

const RAW_AUTHORITY = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/;
const BASE_PATH_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;

interface ParsedUrl {
  readonly origin: NormalizedOrigin;
  readonly url: URL;
}

function parseCanonical(raw: unknown): ParsedUrl {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new OriginPolicyError("invalid_url");
  }
  if (UNSAFE_URL_CHARS.test(raw)) throw new OriginPolicyError("unsafe_characters");

  // Require the literal `scheme://authority` form; WHATWG parsing would
  // otherwise repair inputs such as `https:host` or `https:///host`.
  const authorityMatch = RAW_AUTHORITY.exec(raw);
  if (!authorityMatch) throw new OriginPolicyError("invalid_url");
  const rawScheme = authorityMatch[1].toLowerCase();
  if (rawScheme !== "https" && rawScheme !== "http") {
    throw new OriginPolicyError("unsupported_scheme");
  }
  const rawAuthority = authorityMatch[2];
  if (rawAuthority.includes("@")) throw new OriginPolicyError("userinfo");
  if (rawAuthority.length === 0) throw new OriginPolicyError("invalid_host");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OriginPolicyError("invalid_url");
  }
  if (url.username !== "" || url.password !== "") throw new OriginPolicyError("userinfo");
  const scheme = url.protocol.slice(0, -1);
  if (scheme !== "https" && scheme !== "http") throw new OriginPolicyError("unsupported_scheme");

  const host = url.hostname.toLowerCase();
  if (host.length === 0 || host.endsWith(".") || host.includes("%")) {
    throw new OriginPolicyError("invalid_host");
  }

  let port = DEFAULT_PORTS[scheme];
  if (url.port !== "") {
    const parsedPort = Number(url.port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new OriginPolicyError("invalid_port");
    }
    port = parsedPort;
  } else if (/:\d*$/.test(rawAuthority) && !rawAuthority.endsWith("]")) {
    // An explicit empty or zero port (`host:` / `host:0`) is not a default.
    const explicit = rawAuthority.slice(rawAuthority.lastIndexOf(":") + 1);
    if (explicit === "" || Number(explicit) !== DEFAULT_PORTS[scheme]) {
      throw new OriginPolicyError("invalid_port");
    }
  }

  // Apply the existing allowed-origin SSRF policy to the canonical form only.
  const canonicalOrigin = `${scheme}://${host}${port === DEFAULT_PORTS[scheme] ? "" : `:${port}`}/`;
  if (!isAllowedApiUrl(canonicalOrigin)) throw new OriginPolicyError("disallowed_origin");

  const origin: NormalizedOrigin = Object.freeze({
    scheme,
    host,
    port,
    key: `${scheme}://${host}:${port}`,
  });
  return { origin, url };
}

/** Canonical origin identity; path, query and fragment are ignored. */
export function normalizeOrigin(raw: string): NormalizedOrigin {
  return parseCanonical(raw).origin;
}

/**
 * Trusted REST base: canonical origin plus the configured base path.
 * A base URL carrying a query or fragment is a configuration error.
 */
export function parseApiBase(raw: string): ApiBase {
  const { origin, url } = parseCanonical(raw);
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    throw new OriginPolicyError("query_or_fragment");
  }
  // Validate the raw path too: WHATWG parsing silently resolves dot segments
  // (including percent-encoded ones), which would change the configured base.
  const rawPath = raw.slice(RAW_AUTHORITY.exec(raw)![0].length).replace(/\/+$/, "");
  const trimmed = url.pathname.replace(/\/+$/, "");
  if (rawPath !== trimmed) throw new OriginPolicyError("invalid_path");
  if (trimmed !== "") {
    const segments = trimmed.slice(1).split("/");
    for (const segment of segments) {
      if (segment === "" || segment === "." || segment === ".." || !BASE_PATH_SEGMENT.test(segment)) {
        throw new OriginPolicyError("invalid_path");
      }
    }
  }
  return Object.freeze({ origin, basePath: trimmed });
}

export function sameOrigin(a: NormalizedOrigin, b: NormalizedOrigin): boolean {
  return a.key === b.key;
}

/** Serialize the canonical base URL (default port omitted) without a trailing slash. */
export function apiBaseUrl(base: ApiBase): string {
  const { scheme, host, port } = base.origin;
  const portPart = port === DEFAULT_PORTS[scheme] ? "" : `:${port}`;
  return `${scheme}://${host}${portPart}${base.basePath}`;
}
