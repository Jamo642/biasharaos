// Run once at start-up (synchronously, by server.js) before any database is
// opened: downloads every SQLite file from Supabase Storage that is missing
// locally. Exits non-zero on failure so the server knows not to back up an
// empty disk over the good copies in the bucket.
const { writeFileSync, existsSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { storageConfig, storageHeaders } = require("./cloud-backup");

const DATA_DIR = process.argv[2];
const SAFE_NAME = /^(biashara\.sqlite|tenants\/[0-9a-f-]{36}\.sqlite)$/;

async function list(config, prefix) {
  const res = await fetch(`${config.url}/storage/v1/object/list/${config.bucket}`, {
    method: "POST",
    headers: storageHeaders(config.key, { "content-type": "application/json" }),
    body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`list ${prefix || "/"} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).filter((entry) => entry.id).map((entry) => (prefix ? `${prefix}/${entry.name}` : entry.name));
}

async function download(config, remotePath) {
  const res = await fetch(`${config.url}/storage/v1/object/${config.bucket}/${remotePath}`, {
    headers: storageHeaders(config.key),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`download ${remotePath} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const config = storageConfig();
  if (!config.enabled || !DATA_DIR) return;
  const names = [...(await list(config, "")), ...(await list(config, "tenants"))].filter((name) => SAFE_NAME.test(name));
  let restored = 0;
  for (const name of names) {
    const target = join(DATA_DIR, name);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await download(config, name));
    restored += 1;
  }
  console.log(`Cloud restore: ${restored} of ${names.length} database file(s) downloaded`);
}

main().catch((err) => {
  console.error("Cloud restore failed:", err.message);
  process.exit(1);
});
