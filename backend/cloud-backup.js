// Keeps the SQLite files safe on Render's free plan, whose disk is wiped on
// every restart. After a change, a consistent snapshot of the database
// (VACUUM INTO) is uploaded to a private Supabase Storage bucket; on start-up
// cloud-restore.js downloads them back before any database is opened.
const { readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { randomUUID } = require("node:crypto");

const FLUSH_DELAY_MS = 3000;

function storageConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const bucket = String(env.SUPABASE_BUCKET || "biashara-data").trim();
  return { url, key, bucket, enabled: Boolean(url && key && bucket) };
}

function storageHeaders(key, extra = {}) {
  return { authorization: `Bearer ${key}`, apikey: key, ...extra };
}

function createCloudBackup(config, { log = console } = {}) {
  const pending = new Map();
  let timer = null;
  let flushing = null;

  async function upload(remotePath, body) {
    const res = await fetch(`${config.url}/storage/v1/object/${config.bucket}/${remotePath}`, {
      method: "POST",
      headers: storageHeaders(config.key, { "content-type": "application/octet-stream", "x-upsert": "true" }),
      body,
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`upload ${remotePath} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  // VACUUM INTO writes a consistent copy even while the app keeps using the file.
  function snapshot(db) {
    const file = join(tmpdir(), `bos-backup-${randomUUID()}.sqlite`);
    db.exec(`VACUUM INTO '${file}'`);
    try {
      return readFileSync(file);
    } finally {
      rmSync(file, { force: true });
    }
  }

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (flushing) return flushing;
    const batch = [...pending.entries()];
    pending.clear();
    flushing = (async () => {
      for (const [remotePath, db] of batch) {
        try {
          await upload(remotePath, snapshot(db));
        } catch (err) {
          log.error("Cloud backup failed:", err.message);
          if (!pending.has(remotePath)) pending.set(remotePath, db);
        }
      }
    })();
    try {
      await flushing;
    } finally {
      flushing = null;
    }
    if (pending.size) schedule();
  }

  function schedule() {
    if (!timer) timer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_DELAY_MS);
  }

  function markDirty(remotePath, db) {
    if (!config.enabled || !db) return;
    pending.set(remotePath, db);
    schedule();
  }

  return { enabled: config.enabled, markDirty, flush };
}

module.exports = { storageConfig, storageHeaders, createCloudBackup };
