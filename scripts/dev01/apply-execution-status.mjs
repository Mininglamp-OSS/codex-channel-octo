// Evidence is external to the source tree; do not persist head-specific pass
// claims in the matrix. Use the parity gate's freshly verified report instead.
import { readFileSync } from 'node:fs';
import { verifyAgainstJUnit } from '../parity/validate-matrix.mjs';
import { captureSourceState } from '../ci/source-state.mjs';
const matrix = JSON.parse(readFileSync('test/parity-matrix.json', 'utf8'));
const result = verifyAgainstJUnit(matrix, [readFileSync(process.argv[2], 'utf8')], { head: captureSourceState(process.cwd()).head });
console.log(JSON.stringify(result, null, 2));
process.exit(result.issues.length ? 1 : 0);
