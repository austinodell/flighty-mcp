/** Hourly and queued account refresh. Kept separate from the OAuth entrypoint so tests can run it in Node. */
import { FlightyClient } from './client.js';
import { setEnv, type Env, type SyncQueueMessage } from './env.js';
import { runSyncJob } from './refresh.js';
import { AccountStore } from './store.js';

export async function handleSyncMessage(env: Env, message: SyncQueueMessage): Promise<void> {
  setEnv(env);
  const token = typeof env.FLIGHTY_TOKEN === 'string' ? env.FLIGHTY_TOKEN : '';
  if (!token || !env.DB) {
    console.error(JSON.stringify({ message: 'sync_skipped', reason: token ? 'no_database' : 'no_flighty_token' }));
    return;
  }
  const client = new FlightyClient();
  const store = new AccountStore(env.DB);
  const view = await runSyncJob({
    client,
    store,
    token,
    op: message.op,
    force: message.force,
    pages: client.settings.syncPagesPerRun,
  });
  if (view.already_running && message.op === 'continue') throw new Error('sync busy');
  if (view.more && !view.already_running && !view.refresh_limited && env.SYNC_QUEUE) {
    await env.SYNC_QUEUE.send({ op: 'continue' });
  }
  console.log(JSON.stringify({
    message: 'sync_step',
    op: message.op,
    status: view.status,
    pages_done: view.pages_done,
    more: view.more,
    refresh_limited: view.refresh_limited,
  }));
}

export async function handleScheduled(env: Env, purge?: (env: Env) => Promise<unknown>): Promise<void> {
  setEnv(env);
  console.log(JSON.stringify({ message: 'cron_refresh' }));
  if (!env.FLIGHTY_TOKEN) {
    console.error(JSON.stringify({ message: 'cron_skipped', reason: 'no_flighty_token' }));
  } else if (env.SYNC_QUEUE) {
    await env.SYNC_QUEUE.send({ op: 'start' });
  } else if (env.DB) {
    const client = new FlightyClient();
    await runSyncJob({
      client,
      store: new AccountStore(env.DB),
      token: env.FLIGHTY_TOKEN,
      op: 'start',
      force: true,
      pages: client.settings.maxPages,
    });
  }
  if (!purge) return;
  try {
    await purge(env);
  } catch (error) {
    console.error(JSON.stringify({ message: 'oauth_purge_failed', error: error instanceof Error ? error.message : 'error' }));
  }
}
