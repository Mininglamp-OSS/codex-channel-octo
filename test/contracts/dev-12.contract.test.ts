/**
 * Named pending contracts for DEV-12 (R8 §4/§5 parity matrix).
 * Each it.todo is a placeholder the owning stage replaces with an executable
 * test; todo cases are reported pending and can never back a passed row.
 */
import { describe, it } from 'vitest';

describe('DEV-12 pending contracts', () => {
  it.todo('O13 (DEV-12): Outbound media/file/RichText');
  it.todo('EP-04 (DEV-12): type 2/8 media/file');
  it.todo('EP-05 (DEV-12): type 14 RichText');
  it.todo('EP-21 (DEV-12): upload/credentials (STS, A legacy)');
  it.todo('EP-22 (DEV-12): upload/presigned + PUT');
  it.todo('K-04 (DEV-12): `cdnUrl` (A: STS probe)');
  it.todo('EP-04.image (DEV-12): type 2/8 media/file — image');
  it.todo('EP-04.file (DEV-12): type 2/8 media/file — file');
  it.todo('EP-05.richtext (DEV-12): type 14 RichText — richtext');
  it.todo('EP-21.get (DEV-12): upload/credentials (STS, A legacy) — get');
  it.todo('EP-22.presigned (DEV-12): upload/presigned + PUT — presigned');
  it.todo('EP-22.put (DEV-12): upload/presigned + PUT — put');
});
