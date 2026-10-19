import { readFileSync } from 'node:fs';

/** Source and dependency pins from R8 (test/pins.json is the single copy). */
export const pins = JSON.parse(readFileSync(new URL('../pins.json', import.meta.url), 'utf8')) as {
  A: string; B: string; OC: string; codex: string; codexRust: string; croner: string;
};
