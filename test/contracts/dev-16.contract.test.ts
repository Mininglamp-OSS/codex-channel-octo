/**
 * Named pending contracts for DEV-16 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-16 pending contracts', () => {
  it.todo('I36 (DEV-16): Doc-comment mention intake');
  it.todo('O22 (DEV-16): Doc/PPT/bot tasks');
  it.todo('EP-27 (DEV-16): docs comments/comment-task/ppt/replies');
  it.todo('K-12 (DEV-16): `docsApiUrl`, `docsCliPath`, `docTasks`, `docTaskProgress`, `botTasks` (A: missing)');
  it.todo('K-13 (DEV-16): `onBehalfOf` (A: missing)');
  it.todo('K-14 (DEV-16): `secretsFileRoot` (A: missing)');
  it.todo('EP-27.comments (DEV-16): docs comments/comment-task/ppt/replies — comments');
  it.todo('EP-27.comment-task (DEV-16): docs comments/comment-task/ppt/replies — comment-task');
  it.todo('EP-27.ppt (DEV-16): docs comments/comment-task/ppt/replies — ppt');
  it.todo('EP-27.replies (DEV-16): docs comments/comment-task/ppt/replies — replies');
});
