import type * as api from './octo/api.js';
export interface Box { nested: typeof api; next?: Box }
