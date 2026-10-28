/** Reviewed runtime ICU versions; no tz data is packaged or inferred at runtime. */
import { readonlySet } from './profile-parse.js';

export type TzVersionReader = () => string | undefined;
export const SUPPORTED_TZ_VERSIONS: ReadonlySet<string> = readonlySet(['2025b', '2026e']);
/** Sole production read of the runtime version. */
export const runtimeTzVersion: TzVersionReader = () => process.versions.tz;
