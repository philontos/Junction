import type { Request, Response } from 'express';
import { JunctionClient, JunctionError } from '../../../apps/workbench/server/junction/client.js';
import { CloudError } from './store.js';

const id = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const readPath = new RegExp(`^/contexts(?:/${id}/revisions(?:/${id}(?:/(?:messages|turns|diagnostics|records|export|messages/m[0-9]+/content))?)?)?$`, 'i');

/** Browser reads use the signed-in cloud account; no online node is required.
 * Writes and raw records are deliberately outside this read-only UI endpoint.
 * The Context service remains the authority for visibility and permissions. */
export async function readContext(req: Request, res: Response, port: number, account: { id: string; junction_token_file: string }) {
  if (req.method !== 'GET' || !readPath.test(req.path)) throw new CloudError(404, 'Context 接口不存在。');
  const client = new JunctionClient({ url: `http://127.0.0.1:${port}`, default_account: account.id,
    accounts: [{ id: account.id, label: account.id, token_file: account.junction_token_file }] });
  const abort = new AbortController();
  res.once('close', () => { if (!res.writableEnded) abort.abort(); });
  try {
    if (req.path.endsWith('/export')) {
      const [, , cid, , rid] = req.path.split('/');
      const snapshot = await client.snapshot(cid, rid, abort.signal);
      res.attachment(`context-${rid}.json`).json(snapshot.normalized); return;
    }
    const query = new URLSearchParams();
    for (const key of ['cursor', 'limit', 'view', 'turn_id', 'tail_turns', 'offset']) {
      if (typeof req.query[key] === 'string') query.set(key, req.query[key] as string);
    }
    if (req.path === '/contexts' || req.path.endsWith('/revisions')) {
      query.set('shared_only', 'true'); if (!query.has('limit')) query.set('limit', '20');
    }
    res.json(await client.request('/v1' + req.path + '?' + query, { signal: abort.signal }));
  } catch (error) {
    if (error instanceof JunctionError) throw new CloudError(error.status, error.message);
    throw error;
  }
}
