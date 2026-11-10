const MASK = '[REDACTED]';
const CREDENTIAL = '(?:authorization|proxy[-_]authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|client[-_]secret|cookie|set[-_]cookie)';
const field = new RegExp(`(["']?\\b${CREDENTIAL}["']?\\s*[:=]\\s*)((?:Bearer|Basic)[ \t]+[^\\s,;<>]+|\\[REDACTED\\]|"(?:[^"\\\\]|\\\\.)*(?:"|$)|'(?:[^'\\\\]|\\\\.)*(?:'|$)|[^\\s,;&}\\]<>]+)`, 'gi');
const header = /\b((?:proxy-)?authorization|(?:set-)?cookie)([ \t]*:[ \t]*)([^\r\n]+)/gi;

/** Best-effort credential masking, not a guarantee for arbitrary private text.
 * Operates on supplied strings only; never loads credentials or invokes objects. */
export function redactErrorText(text: string): string {
  return text
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, MASK)
    .replace(/\b(https?:\/\/)[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(header, (_match, key: string, separator: string, value: string) => `${key}${separator}${/^(Bearer|Basic) /i.exec(value)?.[0] ?? ''}${MASK}`)
    .replace(/\b(Bearer|Basic)[ \t]+[^\s,"';<>]+/gi, `$1 ${MASK}`)
    .replace(field, (_match, prefix: string, value: string) => {
      const scheme = /^(Bearer|Basic)[ \t]+/i.exec(value);
      if (scheme) return `${prefix}${scheme[0]}${MASK}`;
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${prefix}${quote}${MASK}${quote}`;
    });
}

/** Structured credential values are hidden even when nested or non-string. */
export function isCredentialField(key: string): boolean {
  return /^(?:authorization|proxy[-_]?authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|client[-_]?secret|cookie|set[-_]?cookie)$/i.test(key);
}
