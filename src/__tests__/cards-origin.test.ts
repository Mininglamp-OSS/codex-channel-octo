import { describe, expect, it } from "vitest";
import {
  apiBaseUrl,
  normalizeOrigin,
  OriginPolicyError,
  parseApiBase,
  sameOrigin,
} from "../cards/origin.js";

function rejectCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OriginPolicyError);
    return (err as OriginPolicyError).code;
  }
  throw new Error("expected rejection");
}

describe("normalizeOrigin", () => {
  it("treats omitted https port, explicit 443, case and trailing path as one origin", () => {
    const keys = [
      "https://api.example.com",
      "https://api.example.com:443",
      "HTTPS://API.Example.COM/",
      "https://api.example.com/v1/base?x=1#frag",
    ].map((u) => normalizeOrigin(u).key);
    expect(new Set(keys)).toEqual(new Set(["https://api.example.com:443"]));
  });

  it("maps Unicode hosts to their IDNA form so both spellings are equivalent", () => {
    const unicode = normalizeOrigin("https://B" + String.fromCharCode(0xdc) + "CHER.example");
    const punycode = normalizeOrigin("https://xn--bcher-kva.example:443/x");
    expect(unicode.host).toBe("xn--bcher-kva.example");
    expect(sameOrigin(unicode, punycode)).toBe(true);
  });

  it("keeps different ports and schemes as different origins", () => {
    const a = normalizeOrigin("https://api.example.com");
    expect(sameOrigin(a, normalizeOrigin("https://api.example.com:8443"))).toBe(false);
    expect(sameOrigin(a, normalizeOrigin("https://other.example.com"))).toBe(false);
    expect(normalizeOrigin("http://localhost:3000").key).toBe("http://localhost:3000");
    expect(normalizeOrigin("http://127.0.0.1").key).toBe("http://127.0.0.1:80");
  });

  it("rejects userinfo in every form without echoing it", () => {
    for (const u of ["https://user:pass@api.example.com", "https://user@api.example.com", "https://@api.example.com"]) {
      expect(rejectCode(() => normalizeOrigin(u))).toBe("userinfo");
    }
    try {
      normalizeOrigin("https://secretuser:secretpass@api.example.com");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("secret");
    }
  });

  it("rejects control characters, whitespace, backslashes and bidi controls", () => {
    const bad = [
      "https://api.example.com" + String.fromCharCode(0) ,
      "https://api.exa mple.com",
      "https://api.example.com\\@evil.example",
      "https://api.example.com/" + String.fromCharCode(0x202e),
      "https://api.example.com" + String.fromCharCode(0x0a),
    ];
    for (const u of bad) expect(rejectCode(() => normalizeOrigin(u))).toBe("unsafe_characters");
  });

  it("rejects unsupported or malformed forms and fails closed", () => {
    expect(rejectCode(() => normalizeOrigin("ftp://api.example.com"))).toBe("unsupported_scheme");
    expect(rejectCode(() => normalizeOrigin("javascript://api.example.com"))).toBe("unsupported_scheme");
    expect(rejectCode(() => normalizeOrigin("https:api.example.com"))).toBe("invalid_url");
    expect(rejectCode(() => normalizeOrigin("https:///api.example.com"))).toBe("invalid_host");
    expect(rejectCode(() => normalizeOrigin("https://api.example.com:"))).toBe("invalid_port");
    expect(rejectCode(() => normalizeOrigin("https://api.example.com:0"))).toBe("invalid_port");
    expect(rejectCode(() => normalizeOrigin("https://api.example.com."))).toBe("invalid_host");
    expect(rejectCode(() => normalizeOrigin(""))).toBe("invalid_url");
    expect(rejectCode(() => normalizeOrigin("https://" + "a".repeat(3000) + ".example"))).toBe("invalid_url");
  });

  it("applies the existing allowed-origin SSRF policy without weakening it", () => {
    expect(rejectCode(() => normalizeOrigin("http://api.example.com"))).toBe("disallowed_origin");
    expect(rejectCode(() => normalizeOrigin("https://127.0.0.1"))).toBe("disallowed_origin");
    expect(rejectCode(() => normalizeOrigin("https://169.254.169.254"))).toBe("disallowed_origin");
    expect(rejectCode(() => normalizeOrigin("https://[::1]"))).toBe("disallowed_origin");
    expect(rejectCode(() => normalizeOrigin("http://10.0.0.5"))).toBe("disallowed_origin");
  });
});

describe("parseApiBase", () => {
  it("retains the REST base path separately from the origin identity", () => {
    const a = parseApiBase("https://API.example.com:443/octo/api/");
    const b = parseApiBase("https://api.example.com/other");
    expect(a.basePath).toBe("/octo/api");
    expect(b.basePath).toBe("/other");
    expect(sameOrigin(a.origin, b.origin)).toBe(true);
    expect(apiBaseUrl(a)).toBe("https://api.example.com/octo/api");
    expect(apiBaseUrl(parseApiBase("http://localhost:8080"))).toBe("http://localhost:8080");
  });

  it("rejects query, fragment and unsafe path segments", () => {
    expect(rejectCode(() => parseApiBase("https://api.example.com/v1?x=1"))).toBe("query_or_fragment");
    expect(rejectCode(() => parseApiBase("https://api.example.com/v1#f"))).toBe("query_or_fragment");
    expect(rejectCode(() => parseApiBase("https://api.example.com/a//b"))).toBe("invalid_path");
    expect(rejectCode(() => parseApiBase("https://api.example.com/a/%2e%2e/b"))).toBe("invalid_path");
    expect(rejectCode(() => parseApiBase("https://api.example.com/a/../b"))).toBe("invalid_path");
    expect(rejectCode(() => parseApiBase("https://api.example.com/a/./b"))).toBe("invalid_path");
    expect(rejectCode(() => parseApiBase("https://api.example.com/a%2Fb"))).toBe("invalid_path");
  });
});
