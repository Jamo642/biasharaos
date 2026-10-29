const http = require("node:http");
const { readFileSync, existsSync, mkdirSync } = require("node:fs");
const { join, extname } = require("node:path");
const { randomUUID, createHmac, timingSafeEqual } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { AsyncLocalStorage } = require("node:async_hooks");
const { execFileSync } = require("node:child_process");
const { createAuth } = require("./auth");
const { storageConfig, createCloudBackup } = require("./cloud-backup");

// Load .env. After the frontend/backend split, .env lives at the project
// root (one level up from this file), but we also honour a backend/.env for
// local overrides, and fall back to the old same-directory location so a
// vanilla checkout keeps booting.
function loadEnvFile() {
  const candidates = [
    join(__dirname, "..", ".env"),
    join(__dirname, ".env")
  ];
  const envPath = candidates.find(p => existsSync(p));
  if (!envPath) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const USSD_RESPONSE_TIMEOUT_MS = Number(process.env.USSD_RESPONSE_TIMEOUT_MS || 8000);
const ROOT = __dirname;                             // backend/
const PROJECT_ROOT = join(ROOT, "..");              // repo root
const PUBLIC = join(PROJECT_ROOT, "frontend");      // frontend/ served as static
const DATA_DIR = join(ROOT, "data");                // backend/data/ (sqlite)
const DB_PATH = join(DATA_DIR, "biashara.sqlite");
const TENANT_DIR = join(DATA_DIR, "tenants");
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const BREVO_API_KEY = String(process.env.BREVO_API_KEY || "").trim();
const BREVO_SENDER_EMAIL = String(process.env.BREVO_SENDER_EMAIL || "").trim();
const BREVO_SENDER_NAME = String(process.env.BREVO_SENDER_NAME || "Biashara OS").trim();
const EMAIL_CODES_ENABLED = Boolean(BREVO_API_KEY && BREVO_SENDER_EMAIL);
const DEMO_MODE = process.env.DEMO_MODE === "true";

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Render's free disk is wiped on restart, so pull the databases back from
// Supabase Storage before opening any of them. If that fails, backups stay off
// for this run so an empty disk never overwrites the good copies.
const cloudConfig = storageConfig();
let cloudRestoreOk = !cloudConfig.enabled;
if (cloudConfig.enabled) {
  try {
    execFileSync(process.execPath, [join(ROOT, "cloud-restore.js"), DATA_DIR], { stdio: "inherit", timeout: 120000 });
    cloudRestoreOk = true;
  } catch {
    console.error("Cloud restore failed: backups are disabled until the next restart.");
  }
}
const cloud = createCloudBackup({ ...cloudConfig, enabled: cloudConfig.enabled && cloudRestoreOk });
const backupPaths = new Map();

const mainDb = new DatabaseSync(DB_PATH);
backupPaths.set(mainDb, "biashara.sqlite");
mainDb.exec("PRAGMA foreign_keys = ON");

// Each Google account has its own SQLite file under data/tenants/. Requests run
// inside tenantContext, and `db` forwards to that request's database, so every
// query below is isolated per business without carrying a tenant filter.
// Webhooks and the SMS scheduler have no signed-in account and use mainDb.
const tenantContext = new AsyncLocalStorage();
const tenantDbs = new Map();
const db = new Proxy({}, {
  get(_, prop) {
    const target = tenantContext.getStore() || mainDb;
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  }
});

function tenantDb(tenant) {
  if (!TENANT_ID_RE.test(String(tenant))) throw new Error("Invalid workspace id");
  if (tenantDbs.has(tenant)) return tenantDbs.get(tenant);
  if (!existsSync(TENANT_DIR)) mkdirSync(TENANT_DIR, { recursive: true });
  const tdb = new DatabaseSync(join(TENANT_DIR, `${tenant}.sqlite`));
  tdb.exec("PRAGMA foreign_keys = ON");
  tenantContext.run(tdb, migrate);
  tenantDbs.set(tenant, tdb);
  backupPaths.set(tdb, `tenants/${tenant}.sqlite`);
  return tdb;
}

const dbForAccount = (account) => (account && account.tenant ? tenantDb(account.tenant) : mainDb);
// Africa's Talking creates a new webhook request for every USSD turn. Keep a
// small in-memory conversation state so option 5 can continue across turns.
const ussdAiSessions = new Map();
const ussdSessions = new Map();
const pendingActions = new Map();

function addColumnIfMissing(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!String(err.message).includes("duplicate column")) throw err;
  }
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('OWNER','MANAGER','SUPERVISOR','STOREKEEPER','OPERATOR','TECHNICIAN','ACCOUNTANT')),
      created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
      selling_price REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL, supplier TEXT,
      reorder_level REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, item_type TEXT NOT NULL CHECK(item_type IN ('RAW_MATERIAL','WIP','FINISHED_GOOD')),
      item_id TEXT NOT NULL, item_name TEXT NOT NULL, unit TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, inventory_id TEXT NOT NULL, action TEXT NOT NULL,
      quantity REAL NOT NULL, before_qty REAL NOT NULL, after_qty REAL NOT NULL, source TEXT NOT NULL,
      user_id TEXT, production_job_id TEXT, note TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id), FOREIGN KEY(inventory_id) REFERENCES inventory(id)
    );
    CREATE TABLE IF NOT EXISTS production_jobs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, job_no TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
      target_qty REAL NOT NULL, completed_qty REAL NOT NULL DEFAULT 0, status TEXT NOT NULL,
      operator_id TEXT, due_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS production_entries (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, production_job_id TEXT, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
      quantity_produced REAL NOT NULL, operator_id TEXT, source TEXT NOT NULL, original_message TEXT,
      structured_json TEXT, created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, machine_no TEXT NOT NULL, name TEXT NOT NULL, location TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('RUNNING','IDLE','DOWN','MAINTENANCE')), current_operator_id TEXT,
      technician_id TEXT, last_maintenance TEXT, next_maintenance TEXT, total_downtime_minutes REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS downtime_events (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, machine_id TEXT NOT NULL, status TEXT NOT NULL,
      reported_by TEXT, technician_id TEXT, acknowledged_at TEXT, resolved_at TEXT, downtime_minutes REAL,
      escalation_level INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, original_message TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id), FOREIGN KEY(machine_id) REFERENCES machines(id)
    );
    CREATE TABLE IF NOT EXISTS maintenance_events (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, machine_id TEXT NOT NULL, event_type TEXT NOT NULL,
      note TEXT, technician_id TEXT, created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, email TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, order_no TEXT NOT NULL, customer_id TEXT NOT NULL,
      status TEXT NOT NULL, total_amount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
      quantity REAL NOT NULL, unit_price REAL NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, invoice_no TEXT NOT NULL, order_id TEXT NOT NULL,
      amount REAL NOT NULL, status TEXT NOT NULL, issued_at TEXT NOT NULL, paid_at TEXT
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, invoice_id TEXT NOT NULL, provider TEXT NOT NULL,
      amount REAL NOT NULL, reference TEXT NOT NULL, status TEXT NOT NULL, raw_payload TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_transactions (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, item_name TEXT NOT NULL, quantity REAL NOT NULL,
      unit TEXT NOT NULL, amount REAL NOT NULL, customer_id TEXT, customer_name TEXT, payment_status TEXT NOT NULL DEFAULT 'PAID',
      source TEXT NOT NULL, user_id TEXT, original_message TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, supplier_id TEXT, supplier_name TEXT, item_name TEXT NOT NULL,
      quantity REAL NOT NULL, unit TEXT NOT NULL, total_cost REAL NOT NULL, payment_status TEXT NOT NULL DEFAULT 'PAID',
      source TEXT NOT NULL, user_id TEXT, original_message TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, category TEXT NOT NULL, description TEXT, amount REAL NOT NULL,
      user_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_debts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, customer_id TEXT NOT NULL, sale_id TEXT, amount_owed REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, due_date TEXT, created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id), FOREIGN KEY(customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS supplier_debts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, supplier_id TEXT NOT NULL, purchase_id TEXT, amount_owed REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, due_date TEXT, created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id), FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
    );
    CREATE TABLE IF NOT EXISTS debt_payments (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, debt_id TEXT NOT NULL, debt_type TEXT NOT NULL, amount REAL NOT NULL,
      payment_method TEXT NOT NULL, reference TEXT, user_id TEXT, created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, assigned_user_id TEXT,
      entity_type TEXT, entity_id TEXT, created_at TEXT NOT NULL, acknowledged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, channel TEXT NOT NULL, recipient TEXT NOT NULL,
      message TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, provider_ref TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, user_id TEXT, channel TEXT NOT NULL,
      message TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_actions (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT, intent TEXT NOT NULL,
      structured_json TEXT NOT NULL, requires_confirmation INTEGER NOT NULL DEFAULT 0,
      confirmed INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, actor_user_id TEXT, action TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT, before_json TEXT, after_json TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL
    );
    -- Jua Kali extensions ----------------------------------------------------
    -- A chama is the pooled savings group every Jua Kali cluster has. Members
    -- deposit, borrow and repay against the group balance.
    CREATE TABLE IF NOT EXISTS chama_members (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT,
      role TEXT NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('MEMBER','MWENYEKITI','KATIBU','MWEKA_HAZINA')),
      joined_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    -- Every deposit/withdraw/loan/repay in the chama ledger. Balance = SUM(
    -- kind IN (DEPOSIT,REPAY)) - SUM(kind IN (WITHDRAW,LOAN)).
    CREATE TABLE IF NOT EXISTS chama_contributions (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, member_id TEXT NOT NULL, amount REAL NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('DEPOSIT','WITHDRAW','LOAN','REPAY')),
      note TEXT, source TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id), FOREIGN KEY(member_id) REFERENCES chama_members(id)
    );
    -- Piecework: pay per job done. Each row is a tally the group settles
    -- weekly. amount = units * rate at log time (locked).
    CREATE TABLE IF NOT EXISTS piecework_entries (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, worker_name TEXT NOT NULL, user_id TEXT,
      job TEXT NOT NULL, units REAL NOT NULL, rate REAL NOT NULL, amount REAL NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0, paid_at TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(company_id) REFERENCES companies(id)
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      day TEXT PRIMARY KEY, count INTEGER NOT NULL
    );
  `);
  // Schema migrations for existing databases
  addColumnIfMissing("sales_transactions", "customer_id", "TEXT");
  addColumnIfMissing("sales_transactions", "customer_name", "TEXT");
  addColumnIfMissing("sales_transactions", "payment_status", "TEXT NOT NULL DEFAULT 'PAID'");
}

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;
// Coerce undefined values to null so Node.js sqlite does not reject them
function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? null : v;
  return out;
}
const get = (sql, params = {}) => db.prepare(sql).get(cleanParams(params));
const all = (sql, params = {}) => db.prepare(sql).all(cleanParams(params));
const run = (sql, params = {}) => db.prepare(sql).run(cleanParams(params));
function withTransaction(callback) {
  db.exec("BEGIN");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const companyId = () => get("SELECT id FROM companies LIMIT 1")?.id;

function seed() {
  if (get("SELECT id FROM companies LIMIT 1")) return;

  // Helper: ISO timestamp N days ago at a given hour
  const ago = (days, hour = 10) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  const company = "co_biashara";
  run("INSERT INTO companies VALUES (:id,:name,:city,:created_at)", { id: company, name: "Karatasi Metal Works", city: "Nairobi", created_at: ago(60) });

  // ── Users ──────────────────────────────────────────────
  const users = [
    ["usr_owner", "Amina Otieno",      "+254700000001", "OWNER"],
    ["usr_mgr",   "David Mwangi",      "+254700000002", "MANAGER"],
    ["usr_store", "Wanjiku Kamau",     "+254700000003", "STOREKEEPER"],
    ["usr_op",    "Juma Baraka",       "+254700000004", "OPERATOR"],
    ["usr_tech",  "Njoroge Muthoni",   "+254700000005", "TECHNICIAN"],
    ["usr_acc",   "Faith Nyambura",    "+254700000006", "ACCOUNTANT"]
  ];
  for (const [uid, name, phone, role] of users) {
    run("INSERT INTO users VALUES (:id,:company_id,:name,:phone,:role,:created_at)", { id: uid, company_id: company, name, phone, role, created_at: ago(60) });
  }

  // ── Products ───────────────────────────────────────────
  const products = [
    ["prod_door",    "DOOR-STL",  "Steel Doors",    "units", 18000],
    ["prod_window",  "WIN-STL",   "Steel Windows",  "units",  8500],
    ["prod_gate",    "GATE-STL",  "Steel Gates",    "units", 35000]
  ];
  for (const [pid, sku, name, unit, price] of products) {
    run("INSERT INTO products VALUES (:id,:company_id,:sku,:name,:unit,:selling_price,:created_at)", { id: pid, company_id: company, sku, name, unit, selling_price: price, created_at: ago(60) });
    run("INSERT INTO inventory VALUES (:id,:company_id,'FINISHED_GOOD',:item_id,:item_name,:unit,0,0,:updated_at)", { id: `inv_${pid}`, company_id: company, item_id: pid, item_name: name, unit, updated_at: ago(60) });
  }

  // ── Materials ──────────────────────────────────────────
  const materials = [
    ["mat_steel",  "Steel",  "kg",  "Kamukunji Steel Traders", 85,  420],
    ["mat_paint",  "Paint",  "L",   "Industrial Paints KE",    15,   72],
    ["mat_hinges", "Hinges", "pcs", "Gikomba Hardware",        50,  310],
    ["mat_welrod", "Welding Rods", "pcs", "Kamukunji Steel Traders", 100, 80]
  ];
  for (const [mid, name, unit, supplier, reorder, qty] of materials) {
    run("INSERT INTO materials VALUES (:id,:company_id,:name,:unit,:supplier,:reorder_level,:created_at)", { id: mid, company_id: company, name, unit, supplier, reorder_level: reorder, created_at: ago(60) });
    run("INSERT INTO inventory VALUES (:id,:company_id,'RAW_MATERIAL',:item_id,:item_name,:unit,:quantity,:reorder_level,:updated_at)", { id: `inv_${mid}`, company_id: company, item_id: mid, item_name: name, unit, quantity: qty, reorder_level: reorder, updated_at: ago(60) });
  }

  // ── Machines ───────────────────────────────────────────
  const machines = [
    ["mach_1", "Machine 1", "Hydraulic Press",     "Bay A",     "RUNNING", "usr_op", "usr_tech"],
    ["mach_2", "Machine 2", "Door Frame Welder",   "Bay B",     "RUNNING", "usr_op", "usr_tech"],
    ["mach_3", "Machine 3", "Spray Booth",         "Paint Area","IDLE",    null,     "usr_tech"],
    ["mach_4", "Machine 4", "CNC Plasma Cutter",   "Bay C",     "RUNNING", "usr_op", "usr_tech"]
  ];
  for (const [mid, no, name, loc, status, op, tech] of machines) {
    run("INSERT INTO machines VALUES (:id,:company_id,:machine_no,:name,:location,:status,:current_operator_id,:technician_id,:last_maintenance,:next_maintenance,0,:updated_at)", {
      id: mid, company_id: company, machine_no: no, name, location: loc, status,
      current_operator_id: op, technician_id: tech,
      last_maintenance: "2025-07-01", next_maintenance: "2025-09-01", updated_at: ago(1)
    });
  }

  // ── Suppliers ──────────────────────────────────────────
  run("INSERT INTO suppliers VALUES (:id,:company_id,:name,:phone,:email,:created_at)", { id: "sup_steel", company_id: company, name: "Kamukunji Steel Traders", phone: "+254722333444", email: "orders@kamukunjisteel.co.ke", created_at: ago(55) });
  run("INSERT INTO suppliers VALUES (:id,:company_id,:name,:phone,:email,:created_at)", { id: "sup_paint", company_id: company, name: "Industrial Paints KE",    phone: "+254722555666", email: "sales@ipaints.co.ke",         created_at: ago(55) });
  run("INSERT INTO suppliers VALUES (:id,:company_id,:name,:phone,:email,:created_at)", { id: "sup_hard",  company_id: company, name: "Gikomba Hardware",        phone: "+254733888999", email: null,                           created_at: ago(50) });

  // ── Customers ──────────────────────────────────────────
  const customers = [
    ["cust_abc",    "ABC Contractors",      "+254711111111"],
    ["cust_nbo",    "Nairobi Builders Ltd", "+254722222222"],
    ["cust_msa",    "Mombasa Properties",   "+254733333333"],
    ["cust_kib",    "Kibera Housing Co-op", "+254744444444"],
    ["cust_kiambu", "Kiambu Developers",    "+254755555555"]
  ];
  for (const [cid, name, phone] of customers) {
    run("INSERT INTO customers VALUES (:id,:company_id,:name,:phone,:created_at)", { id: cid, company_id: company, name, phone, created_at: ago(50) });
  }

  // ── Production jobs ────────────────────────────────────
  run("INSERT INTO production_jobs VALUES (:id,:company_id,:job_no,:product_id,:product_name,:target_qty,:completed_qty,:status,:operator_id,:due_at,:created_at,:updated_at)", {
    id: "job_1024", company_id: company, job_no: "JOB-1024", product_id: "prod_door", product_name: "Steel Doors",
    target_qty: 50, completed_qty: 38, status: "IN_PROGRESS", operator_id: "usr_op",
    due_at: new Date(Date.now() + 86400000 * 4).toISOString(), created_at: ago(14), updated_at: ago(1)
  });
  run("INSERT INTO production_jobs VALUES (:id,:company_id,:job_no,:product_id,:product_name,:target_qty,:completed_qty,:status,:operator_id,:due_at,:created_at,:updated_at)", {
    id: "job_1023", company_id: company, job_no: "JOB-1023", product_id: "prod_window", product_name: "Steel Windows",
    target_qty: 30, completed_qty: 30, status: "COMPLETED", operator_id: "usr_op",
    due_at: ago(5), created_at: ago(25), updated_at: ago(5)
  });
  run("INSERT INTO production_jobs VALUES (:id,:company_id,:job_no,:product_id,:product_name,:target_qty,:completed_qty,:status,:operator_id,:due_at,:created_at,:updated_at)", {
    id: "job_1022", company_id: company, job_no: "JOB-1022", product_id: "prod_gate", product_name: "Steel Gates",
    target_qty: 10, completed_qty: 10, status: "COMPLETED", operator_id: "usr_op",
    due_at: ago(12), created_at: ago(30), updated_at: ago(12)
  });

  // ── Production entries (spread over 30 days) ───────────
  const prodEntries = [
    // [daysAgo, productId, productName, qty, job]
    [28, "prod_door",    "Steel Doors",   5, "job_1024"],
    [26, "prod_door",    "Steel Doors",   4, "job_1024"],
    [24, "prod_window",  "Steel Windows", 6, "job_1023"],
    [22, "prod_gate",    "Steel Gates",   2, "job_1022"],
    [20, "prod_door",    "Steel Doors",   5, "job_1024"],
    [18, "prod_window",  "Steel Windows", 5, "job_1023"],
    [16, "prod_door",    "Steel Doors",   6, "job_1024"],
    [14, "prod_gate",    "Steel Gates",   3, "job_1022"],
    [12, "prod_window",  "Steel Windows", 4, "job_1023"],
    [10, "prod_door",    "Steel Doors",   5, "job_1024"],
    [ 8, "prod_gate",    "Steel Gates",   2, "job_1022"],
    [ 6, "prod_door",    "Steel Doors",   4, "job_1024"],
    [ 5, "prod_window",  "Steel Windows", 4, "job_1023"],
    [ 4, "prod_door",    "Steel Doors",   5, "job_1024"],
    [ 3, "prod_door",    "Steel Doors",   4, "job_1024"],
    [ 2, "prod_gate",    "Steel Gates",   2, "job_1022"],
    [ 1, "prod_door",    "Steel Doors",   5, "job_1024"],
    [ 0, "prod_door",    "Steel Doors",   3, "job_1024"]
  ];
  for (const [d, productId, product, qty, jobId] of prodEntries) {
    const eid = id("pe");
    const ts = ago(d, 9);
    run("INSERT INTO production_entries (id,company_id,production_job_id,product_id,product_name,quantity_produced,operator_id,source,original_message,structured_json,created_at) VALUES (:id,:company_id,:production_job_id,:product_id,:product_name,:quantity_produced,:operator_id,:source,:original_message,:structured_json,:created_at)", {
      id: eid, company_id: company, production_job_id: jobId, product_id: productId,
      product_name: product, quantity_produced: qty, operator_id: "usr_op",
      source: "WEB", original_message: null, structured_json: null, created_at: ts
    });
  }

  // ── Sales (spread over 30 days) ────────────────────────
  const sales = [
    // [daysAgo, item, qty, unit, amount, customer, status]
    [29, "Steel Doors",   3, "units",  54000, "ABC Contractors",      "PAID"],
    [27, "Steel Windows", 6, "units",  51000, "Nairobi Builders Ltd", "PAID"],
    [25, "Steel Doors",   2, "units",  36000, "Mombasa Properties",   "CREDIT"],
    [23, "Steel Gates",   1, "units",  35000, "Kiambu Developers",    "PAID"],
    [21, "Steel Doors",   4, "units",  72000, "ABC Contractors",      "PAID"],
    [19, "Steel Windows", 4, "units",  34000, "Kibera Housing Co-op", "CREDIT"],
    [17, "Steel Doors",   3, "units",  54000, "Nairobi Builders Ltd", "PAID"],
    [15, "Steel Gates",   2, "units",  70000, "Kiambu Developers",    "PAID"],
    [13, "Steel Doors",   5, "units",  90000, "ABC Contractors",      "PAID"],
    [11, "Steel Windows", 8, "units",  68000, "Mombasa Properties",   "PAID"],
    [ 9, "Steel Doors",   2, "units",  36000, "Kibera Housing Co-op", "CREDIT"],
    [ 7, "Steel Gates",   1, "units",  35000, "ABC Contractors",      "PAID"],
    [ 6, "Steel Doors",   3, "units",  54000, "Nairobi Builders Ltd", "PAID"],
    [ 5, "Steel Windows", 5, "units",  42500, "Kiambu Developers",    "PAID"],
    [ 4, "Steel Doors",   4, "units",  72000, "ABC Contractors",      "PAID"],
    [ 3, "Steel Gates",   2, "units",  70000, "Mombasa Properties",   "PAID"],
    [ 2, "Steel Doors",   2, "units",  36000, "Nairobi Builders Ltd", "PAID"],
    [ 1, "Steel Windows", 3, "units",  25500, "ABC Contractors",      "PAID"],
    [ 0, "Steel Doors",   3, "units",  54000, "ABC Contractors",      "PAID"],
    [ 0, "Steel Gates",   1, "units",  35000, "Kiambu Developers",    "PAID"]
  ];
  for (const [d, item, qty, unit, amount, custName, status] of sales) {
    const sid = id("sale");
    const ts = ago(d, 11);
    const cust = customers.find(([,n]) => n === custName);
    const custId = cust ? cust[0] : null;
    run("INSERT INTO sales_transactions (id,company_id,item_name,quantity,unit,amount,customer_id,customer_name,payment_status,source,user_id,original_message,created_at) VALUES (:id,:company_id,:item_name,:quantity,:unit,:amount,:customer_id,:customer_name,:payment_status,:source,:user_id,:original_message,:created_at)", {
      id: sid, company_id: company, item_name: item, quantity: qty, unit, amount,
      customer_id: custId, customer_name: custName, payment_status: status,
      source: "WEB", user_id: "usr_owner", original_message: null, created_at: ts
    });
    if (status === "CREDIT" && custId) {
      const dueTs = new Date(Date.now() - (d - 14) * 86400000).toISOString().slice(0, 10);
      run("INSERT INTO customer_debts VALUES (:id,:company_id,:customer_id,:sale_id,:amount_owed,:amount_paid,:status,:due_date,:created_at)", {
        id: id("debt"), company_id: company, customer_id: custId, sale_id: sid,
        amount_owed: amount, amount_paid: 0, status: "UNPAID", due_date: dueTs, created_at: ts
      });
    }
  }

  // ── Purchases (spread over 30 days) ───────────────────
  const purchases = [
    // [daysAgo, supplier, item, qty, unit, cost, status]
    [28, "Kamukunji Steel Traders", "Steel",        200, "kg",  28000, "PAID"],
    [24, "Industrial Paints KE",    "Paint",         40, "L",    6400, "PAID"],
    [22, "Kamukunji Steel Traders", "Steel",        300, "kg",  42000, "PAID"],
    [20, "Gikomba Hardware",        "Hinges",       200, "pcs",  4000, "PAID"],
    [18, "Kamukunji Steel Traders", "Welding Rods", 100, "pcs",  3500, "CREDIT"],
    [15, "Kamukunji Steel Traders", "Steel",        250, "kg",  35000, "PAID"],
    [12, "Industrial Paints KE",    "Paint",         30, "L",    4800, "CREDIT"],
    [10, "Gikomba Hardware",        "Hinges",       150, "pcs",  3000, "PAID"],
    [ 8, "Kamukunji Steel Traders", "Steel",        200, "kg",  28000, "PAID"],
    [ 6, "Kamukunji Steel Traders", "Welding Rods",  50, "pcs", 1750, "PAID"],
    [ 4, "Industrial Paints KE",    "Paint",         20, "L",    3200, "PAID"],
    [ 2, "Kamukunji Steel Traders", "Steel",        150, "kg",  21000, "PAID"],
    [ 1, "Gikomba Hardware",        "Hinges",       100, "pcs", 2000, "CREDIT"]
  ];
  const supMap = { "Kamukunji Steel Traders": "sup_steel", "Industrial Paints KE": "sup_paint", "Gikomba Hardware": "sup_hard" };
  for (const [d, supName, item, qty, unit, cost, status] of purchases) {
    const pid2 = id("pur");
    const ts = ago(d, 8);
    const supId = supMap[supName] || null;
    run("INSERT INTO purchases VALUES (:id,:company_id,:supplier_id,:supplier_name,:item_name,:quantity,:unit,:total_cost,:payment_status,:source,:user_id,:original_message,:created_at)", {
      id: pid2, company_id: company, supplier_id: supId, supplier_name: supName, item_name: item,
      quantity: qty, unit, total_cost: cost, payment_status: status,
      source: "WEB", user_id: "usr_store", original_message: null, created_at: ts
    });
    if (status === "CREDIT" && supId) {
      const dueTs = new Date(Date.now() - (d - 21) * 86400000).toISOString().slice(0, 10);
      run("INSERT INTO supplier_debts VALUES (:id,:company_id,:supplier_id,:purchase_id,:amount_owed,:amount_paid,:status,:due_date,:created_at)", {
        id: id("debt"), company_id: company, supplier_id: supId, purchase_id: pid2,
        amount_owed: cost, amount_paid: 0, status: "UNPAID", due_date: dueTs, created_at: ts
      });
    }
  }

  // ── Expenses (spread over 30 days) ────────────────────
  const expenses = [
    [29, "RENT",        "Monthly factory rent",        55000],
    [28, "WAGES",       "Operator weekly wages",       32000],
    [27, "ELECTRICITY", "KPLC factory bill",           18500],
    [24, "FUEL",        "Delivery truck fuel",          4200],
    [22, "TRANSPORT",   "Materials transport Kamukunji", 3500],
    [20, "MAINTENANCE", "Welder service & parts",      12000],
    [18, "WAGES",       "Operator weekly wages",       32000],
    [15, "AIRTIME",     "Team airtime & bundles",       1800],
    [14, "FUEL",        "Generator fuel",               3600],
    [13, "WATER",       "Water bill",                   2200],
    [11, "REPAIR",      "Spray booth compressor fix",   8500],
    [ 9, "WAGES",       "Operator weekly wages",       32000],
    [ 8, "ELECTRICITY", "KPLC factory bill",           17800],
    [ 7, "TRANSPORT",   "Delivery to Westlands",        2800],
    [ 6, "FUEL",        "Delivery truck fuel",          4000],
    [ 5, "MAINTENANCE", "Hydraulic press oil change",   5500],
    [ 4, "WAGES",       "Operator weekly wages",       32000],
    [ 3, "AIRTIME",     "Team airtime & bundles",       1800],
    [ 2, "RENT",        "Monthly factory rent",        55000],
    [ 1, "FUEL",        "Generator fuel",               3200],
    [ 0, "WAGES",       "Supervisor daily pay",         4500]
  ];
  for (const [d, cat, desc, amount] of expenses) {
    run("INSERT INTO expenses VALUES (:id,:company_id,:category,:description,:amount,:user_id,:source,:created_at)", {
      id: id("exp"), company_id: company, category: cat, description: desc,
      amount, user_id: "usr_acc", source: "WEB", created_at: ago(d, 9)
    });
  }

  // ── Orders & Invoices ─────────────────────────────────
  const ordersData = [
    ["cust_abc",    "prod_door",   5, 90000, "COMPLETED", "PAID",    30],
    ["cust_nbo",    "prod_window", 8, 68000, "COMPLETED", "PAID",    22],
    ["cust_msa",    "prod_door",   3, 54000, "IN_PROGRESS","UNPAID", 15],
    ["cust_kib",    "prod_gate",   2, 70000, "PENDING",   "UNPAID",  10],
    ["cust_kiambu", "prod_door",   4, 72000, "PENDING",   "UNPAID",   5]
  ];
  for (const [custId, prodId, qty, amount, ordStatus, invStatus, daysBack] of ordersData) {
    const ordId = id("ord");
    const invId = id("inv");
    const ordNo = `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
    const invNo = `INV-${Math.floor(1000 + Math.random() * 9000)}`;
    const ts = ago(daysBack, 10);
    // orders: id, company_id, order_no, customer_id, status, total_amount, created_at, updated_at
    run("INSERT INTO orders (id,company_id,order_no,customer_id,status,total_amount,created_at,updated_at) VALUES (:id,:company_id,:order_no,:customer_id,:status,:total_amount,:created_at,:updated_at)", {
      id: ordId, company_id: company, order_no: ordNo, customer_id: custId,
      status: ordStatus, total_amount: amount, created_at: ts, updated_at: ts
    });
    // order_items: id, order_id, product_id, product_name, quantity, unit_price
    const prodNameMap = { "prod_door": "Steel Doors", "prod_window": "Steel Windows", "prod_gate": "Steel Gates" };
    run("INSERT INTO order_items (id,order_id,product_id,product_name,quantity,unit_price) VALUES (:id,:order_id,:product_id,:product_name,:quantity,:unit_price)", {
      id: id("oi"), order_id: ordId, product_id: prodId,
      product_name: prodNameMap[prodId] || prodId, quantity: qty, unit_price: amount / qty
    });
    // invoices: id, company_id, invoice_no, order_id, amount, status, issued_at, paid_at
    run("INSERT INTO invoices (id,company_id,invoice_no,order_id,amount,status,issued_at,paid_at) VALUES (:id,:company_id,:invoice_no,:order_id,:amount,:status,:issued_at,:paid_at)", {
      id: invId, company_id: company, invoice_no: invNo, order_id: ordId,
      amount, status: invStatus, issued_at: ts, paid_at: invStatus === "PAID" ? ago(daysBack - 3, 14) : null
    });
  }

  // ── AI conversation log samples ───────────────────────
  const convSamples = [
    [5, "WEB",  "How much profit did I make this week?",        "This week: Revenue KSh 161,500, Expenses KSh 73,000 = Profit KSh 88,500 (54.8% margin).", "profit_report"],
    [4, "SMS",  "Nimeuza milango 2 kwa 36000",                  "Sale recorded: 2 units of Steel Doors sold for KSh 36,000. Remaining stock: 12 units.",  "sale"],
    [3, "WEB",  "What materials are running low?",              "Welding Rods: 80 pcs (reorder at 100 pcs) — below reorder level. Order from Kamukunji Steel Traders.", "inventory_query"],
    [2, "USSD", "Nimenunua chuma kilo 150 kwa 21000",           "Purchase recorded: 150 kg of Steel from supplier for KSh 21,000. Stock now updated.",   "record_purchase"],
    [1, "WEB",  "Record expense: rent 55000",                   "Expense recorded: KSh 55,000 for rent.",                                                  "record_expense"],
    [0, "WEB",  "Show me the business summary",                 "This week you produced 12 units and completed 3 orders. Revenue was KSh 161,500. Steel consumption was 210 kg. Recommendation: Follow up on 3 unpaid invoices.", "business_summary"]
  ];
  for (const [d, channel, message, response, intent] of convSamples) {
    const convId = id("conv");
    const ts = ago(d, 14);
    run("INSERT INTO ai_conversations VALUES (:id,:company_id,:user_id,:channel,:message,:response,:created_at)", {
      id: convId, company_id: company, user_id: "usr_owner", channel, message, response, created_at: ts
    });
    run("INSERT INTO ai_actions VALUES (:id,:company_id,:conversation_id,:intent,:structured_json,:requires_confirmation,:confirmed,:status,:created_at)", {
      id: id("aia"), company_id: company, conversation_id: convId, intent,
      structured_json: JSON.stringify({ intent }), requires_confirmation: 0, confirmed: 1, status: "APPLIED", created_at: ts
    });
  }
}

// ========== SUPPLIER MANAGEMENT ==========
function addSupplier({ name, phone, email, source = "web" }) {
  if (!companyId()) throw new Error("Configure the business workspace before adding suppliers.");
  const supplierId = id("sup");
  run("INSERT INTO suppliers VALUES (:id,:company_id,:name,:phone,:email,:created_at)", {
    id: supplierId, company_id: companyId(), name: String(name).trim(), phone: String(phone || "").trim() || null, email: String(email || "").trim() || null, created_at: now()
  });
  audit({ action: "addSupplier", entityType: "supplier", entityId: supplierId, after: { name, phone, email }, source });
  return { supplierId, name, phone, email };
}

function updateSupplier(supplierId, data) {
  const supplier = get("SELECT * FROM suppliers WHERE id = :id", { id: supplierId });
  if (!supplier) throw new Error("Supplier not found.");
  const before = { ...supplier };
  const name = String(data.name || supplier.name).trim();
  const phone = String(data.phone || supplier.phone || "").trim();
  const email = String(data.email || supplier.email || "").trim();
  run("UPDATE suppliers SET name=:name, phone=:phone, email=:email WHERE id=:id", { name, phone: phone || null, email: email || null, id: supplierId });
  audit({ action: "updateSupplier", entityType: "supplier", entityId: supplierId, before, after: { name, phone, email }, source: "web" });
  return { supplierId, name, phone, email };
}

function deleteSupplier(supplierId) {
  const supplier = get("SELECT * FROM suppliers WHERE id = :id", { id: supplierId });
  if (!supplier) throw new Error("Supplier not found.");
  run("DELETE FROM suppliers WHERE id = :id", { id: supplierId });
  audit({ action: "deleteSupplier", entityType: "supplier", entityId: supplierId, before: supplier, source: "web" });
  return { supplierId, name: supplier.name, deleted: true };
}

function listSuppliers() {
  return all("SELECT id, name, phone, email FROM suppliers WHERE company_id = :cid ORDER BY name", { cid: companyId() });
}

function findSupplier(name) {
  return get("SELECT * FROM suppliers WHERE company_id = :cid AND lower(name) LIKE lower(:name)", { cid: companyId(), name: `%${name}%` });
}

// ========== EXPENSE MANAGEMENT ==========
function recordExpense({ category, description, amount, userId, source = "web" }) {
  if (!companyId()) throw new Error("Configure the business workspace before recording expenses.");
  const expenseId = id("exp");
  run("INSERT INTO expenses VALUES (:id,:company_id,:category,:description,:amount,:user_id,:source,:created_at)", {
    id: expenseId, company_id: companyId(), category: String(category).trim(), description: String(description || "").trim() || null,
    amount: Number(amount), user_id: userId || null, source, created_at: now()
  });
  audit({ action: "recordExpense", entityType: "expense", entityId: expenseId, after: { category, amount }, source });
  return { expenseId, category, amount, description };
}

function listExpenses(period = "all") {
  const company = companyId();
  let sql = "SELECT * FROM expenses WHERE company_id = :cid";
  if (period === "today") sql += " AND date(created_at) = date('now')";
  else if (period === "week") sql += " AND created_at >= datetime('now', '-7 days')";
  else if (period === "month") sql += " AND created_at >= datetime('now', '-30 days')";
  return all(sql + " ORDER BY created_at DESC", { cid: company });
}

// ========== CUSTOMER DEBT MANAGEMENT ==========
function createCustomerDebt({ customerId, saleId, amountOwed, dueDate, source = "web" }) {
  if (!companyId()) throw new Error("Configure the business workspace before recording debts.");
  const debtId = id("debt");
  run("INSERT INTO customer_debts VALUES (:id,:company_id,:customer_id,:sale_id,:amount_owed,:amount_paid,:status,:due_date,:created_at)", {
    id: debtId, company_id: companyId(), customer_id: customerId, sale_id: saleId || null, amount_owed: Number(amountOwed),
    amount_paid: 0, status: "UNPAID", due_date: dueDate || null, created_at: now()
  });
  audit({ action: "createCustomerDebt", entityType: "customer_debt", entityId: debtId, after: { customerId, amountOwed }, source });
  return { debtId, customerId, amountOwed, status: "UNPAID" };
}

function recordDebtPayment({ debtId, amount, paymentMethod = "CASH", reference = null, userId, source = "web" }) {
  const debt = get("SELECT * FROM customer_debts WHERE id = :id", { id: debtId });
  if (!debt) throw new Error("Debt not found.");
  const newPaid = Number(debt.amount_paid) + Number(amount);
  const newStatus = newPaid >= debt.amount_owed ? "PAID" : "PARTIAL";
  run("UPDATE customer_debts SET amount_paid=:amount_paid, status=:status WHERE id=:id", {
    id: debtId, amount_paid: newPaid, status: newStatus
  });
  const paymentId = id("pay");
  run("INSERT INTO debt_payments VALUES (:id,:company_id,:debt_id,:debt_type,:amount,:payment_method,:reference,:user_id,:created_at)", {
    id: paymentId, company_id: companyId(), debt_id: debtId, debt_type: "CUSTOMER", amount: Number(amount),
    payment_method: paymentMethod, reference: reference || null, user_id: userId || null, created_at: now()
  });
  audit({ action: "recordDebtPayment", entityType: "debt_payment", entityId: paymentId, after: { amount, status: newStatus }, source });
  return { paymentId, debtId, amount, status: newStatus };
}

function getCustomerDebts() {
  return all(`
    SELECT cd.*, c.name AS customer_name FROM customer_debts cd
    JOIN customers c ON c.id = cd.customer_id
    WHERE cd.company_id = :cid AND cd.status IN ('UNPAID', 'PARTIAL')
    ORDER BY cd.due_date ASC, cd.created_at DESC
  `, { cid: companyId() });
}

// ========== SUPPLIER DEBT MANAGEMENT ==========
function createSupplierDebt({ supplierId, purchaseId, amountOwed, dueDate, source = "web" }) {
  if (!companyId()) throw new Error("Configure the business workspace before recording payables.");
  const debtId = id("debt");
  run("INSERT INTO supplier_debts VALUES (:id,:company_id,:supplier_id,:purchase_id,:amount_owed,:amount_paid,:status,:due_date,:created_at)", {
    id: debtId, company_id: companyId(), supplier_id: supplierId, purchase_id: purchaseId || null, amount_owed: Number(amountOwed),
    amount_paid: 0, status: "UNPAID", due_date: dueDate || null, created_at: now()
  });
  audit({ action: "createSupplierDebt", entityType: "supplier_debt", entityId: debtId, after: { supplierId, amountOwed }, source });
  return { debtId, supplierId, amountOwed, status: "UNPAID" };
}

function recordSupplierPayment({ debtId, amount, paymentMethod = "CASH", reference = null, userId, source = "web" }) {
  const debt = get("SELECT * FROM supplier_debts WHERE id = :id", { id: debtId });
  if (!debt) throw new Error("Supplier debt not found.");
  const newPaid = Number(debt.amount_paid) + Number(amount);
  const newStatus = newPaid >= debt.amount_owed ? "PAID" : "PARTIAL";
  run("UPDATE supplier_debts SET amount_paid=:amount_paid, status=:status WHERE id=:id", {
    id: debtId, amount_paid: newPaid, status: newStatus
  });
  const paymentId = id("pay");
  run("INSERT INTO debt_payments VALUES (:id,:company_id,:debt_id,:debt_type,:amount,:payment_method,:reference,:user_id,:created_at)", {
    id: paymentId, company_id: companyId(), debt_id: debtId, debt_type: "SUPPLIER", amount: Number(amount),
    payment_method: paymentMethod, reference: reference || null, user_id: userId || null, created_at: now()
  });
  audit({ action: "recordSupplierPayment", entityType: "debt_payment", entityId: paymentId, after: { amount, status: newStatus }, source });
  return { paymentId, debtId, amount, status: newStatus };
}

function getSupplierPayables() {
  return all(`
    SELECT sd.*, s.name AS supplier_name FROM supplier_debts sd
    JOIN suppliers s ON s.id = sd.supplier_id
    WHERE sd.company_id = :cid AND sd.status IN ('UNPAID', 'PARTIAL')
    ORDER BY sd.due_date ASC, sd.created_at DESC
  `, { cid: companyId() });
}

// ========== PROFIT & LOSS CALCULATIONS ==========
function getProfitAndLoss(period = "week") {
  const company = companyId();
  let df = "";       // date filter for created_at columns
  let dfIssued = ""; // date filter for issued_at column (invoices)
  if (period === "today" || period === "day") { df = "AND date(created_at) = date('now')"; dfIssued = "AND date(issued_at) = date('now')"; }
  else if (period === "week") { df = "AND created_at >= datetime('now', '-7 days')"; dfIssued = "AND issued_at >= datetime('now', '-7 days')"; }
  else if (period === "month") { df = "AND created_at >= datetime('now', '-30 days')"; dfIssued = "AND issued_at >= datetime('now', '-30 days')"; }

  // Revenue from sales transactions + paid invoices
  const salesRevenue = get(`SELECT COALESCE(SUM(amount), 0) AS total FROM sales_transactions WHERE company_id = :cid ${df}`, { cid: company }).total;
  const orderRevenue = get(`SELECT COALESCE(SUM(amount), 0) AS total FROM invoices WHERE company_id = :cid AND status = 'PAID' ${dfIssued}`, { cid: company }).total;
  const totalRevenue = Number(salesRevenue) + Number(orderRevenue);

  // Costs: expenses + purchases cost
  const expensesTotal = get(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE company_id = :cid ${df}`, { cid: company }).total;
  const purchaseCosts = get(`SELECT COALESCE(SUM(total_cost), 0) AS total FROM purchases WHERE company_id = :cid ${df}`, { cid: company }).total;
  const totalCosts = Number(expensesTotal) + Number(purchaseCosts);
  const profit = totalRevenue - totalCosts;
  const profitMargin = totalRevenue > 0 ? ((profit / totalRevenue) * 100).toFixed(2) : 0;

  // Category breakdown for expenses
  const expenseByCategory = all(`SELECT category, COALESCE(SUM(amount),0) AS total FROM expenses WHERE company_id = :cid ${df} GROUP BY category ORDER BY total DESC`, { cid: company });

  return {
    period,
    revenue: totalRevenue,
    expenses: totalCosts,
    expensesOnly: Number(expensesTotal),
    purchaseCosts: Number(purchaseCosts),
    profit,
    profitMargin: Number(profitMargin),
    expenseByCategory
  };
}

// ========== JUA KALI EXTENSIONS ==========
// Chama (group savings), piecework (per-job pay), AI pricing suggester,
// daily cashbook, proactive AI (daily summary / dormant customers / price drift).

function findChamaMember(nameOrId) {
  const s = String(nameOrId || "").trim();
  if (!s) return null;
  // Exact id match first, then case-insensitive name LIKE.
  const byId = get("SELECT * FROM chama_members WHERE id=:id", { id: s });
  if (byId) return byId;
  return get("SELECT * FROM chama_members WHERE lower(name) LIKE :pat LIMIT 1", { pat: `%${s.toLowerCase()}%` });
}

function listChamaMembers() {
  const cid = companyId();
  if (!cid) return { error: "Set up the workspace first." };
  const members = all(`
    SELECT m.id, m.name, m.phone, m.role, m.joined_at,
      COALESCE((SELECT SUM(CASE WHEN kind IN ('DEPOSIT','REPAY') THEN amount ELSE -amount END)
                FROM chama_contributions WHERE member_id=m.id), 0) AS balance
    FROM chama_members m WHERE m.company_id=:cid ORDER BY m.joined_at ASC`, { cid });
  const pool = members.reduce((sum, m) => sum + Number(m.balance || 0), 0);
  return { members, pool_balance: pool, member_count: members.length };
}

function addChamaMember({ name, phone, role, source = "WEB", userId = null }) {
  const cid = companyId();
  if (!cid) throw new Error("Set up the workspace first.");
  const cleanName = _requireString(name, "name");
  const existing = get("SELECT * FROM chama_members WHERE company_id=:cid AND lower(name)=lower(:name)", { cid, name: cleanName });
  if (existing) return { memberId: existing.id, name: existing.name, duplicate: true };
  const mid = id("chm");
  const roleVal = ["MEMBER","MWENYEKITI","KATIBU","MWEKA_HAZINA"].includes(String(role || "").toUpperCase()) ? String(role).toUpperCase() : "MEMBER";
  run("INSERT INTO chama_members VALUES (:id,:cid,:name,:phone,:role,:joined_at)", { id: mid, cid, name: cleanName, phone: phone || null, role: roleVal, joined_at: now() });
  audit({ actorUserId: userId, action: "addChamaMember", entityType: "chama_member", entityId: mid, after: { name: cleanName, role: roleVal }, source });
  return { memberId: mid, name: cleanName, role: roleVal };
}

function logChamaContribution({ member, amount, kind = "DEPOSIT", note, source = "WEB", userId = null }) {
  const cid = companyId();
  if (!cid) throw new Error("Set up the workspace first.");
  const amt = _requirePositive(amount, "amount");
  const kindVal = ["DEPOSIT","WITHDRAW","LOAN","REPAY"].includes(String(kind || "").toUpperCase()) ? String(kind).toUpperCase() : "DEPOSIT";
  const found = findChamaMember(member);
  if (!found) throw new Error(`Chama member "${member}" not found. Add them first with add_chama_member.`);
  const cid2 = id("cco");
  run("INSERT INTO chama_contributions VALUES (:id,:cid,:member_id,:amount,:kind,:note,:source,:user_id,:created_at)",
    { id: cid2, cid, member_id: found.id, amount: amt, kind: kindVal, note: note || null, source, user_id: userId, created_at: now() });
  const balance = getChamaBalance(found.id);
  audit({ actorUserId: userId, action: "logChamaContribution", entityType: "chama_contribution", entityId: cid2, after: { member: found.name, amount: amt, kind: kindVal }, source });
  return { contributionId: cid2, member: found.name, amount: amt, kind: kindVal, memberBalance: balance.balance };
}

function getChamaBalance(member) {
  const cid = companyId();
  if (!cid) return { error: "Set up the workspace first." };
  if (!member) {
    // whole-chama pool
    const r = get(`SELECT COALESCE(SUM(CASE WHEN kind IN ('DEPOSIT','REPAY') THEN amount ELSE -amount END), 0) AS balance
                   FROM chama_contributions WHERE company_id=:cid`, { cid });
    return { scope: "pool", balance: Number(r.balance) };
  }
  const found = findChamaMember(member);
  if (!found) return { error: `Chama member "${member}" not found.` };
  const r = get(`SELECT COALESCE(SUM(CASE WHEN kind IN ('DEPOSIT','REPAY') THEN amount ELSE -amount END), 0) AS balance
                 FROM chama_contributions WHERE company_id=:cid AND member_id=:mid`, { cid, mid: found.id });
  const recent = all("SELECT amount, kind, note, created_at FROM chama_contributions WHERE member_id=:mid ORDER BY created_at DESC LIMIT 5", { mid: found.id });
  return { scope: "member", memberId: found.id, member: found.name, balance: Number(r.balance), recent };
}

function recordPiecework({ worker, job, units, rate, source = "WEB", userId = null }) {
  const cid = companyId();
  if (!cid) throw new Error("Set up the workspace first.");
  const workerName = _requireString(worker, "worker");
  const jobLabel = _requireString(job, "job");
  const u = _requirePositive(units, "units");
  const r = _requirePositive(rate, "rate");
  const amt = u * r;
  const pid = id("pwk");
  run("INSERT INTO piecework_entries VALUES (:id,:cid,:worker,:user_id,:job,:units,:rate,:amount,0,NULL,:source,:created_at)",
    { id: pid, cid, worker: workerName, user_id: userId, job: jobLabel, units: u, rate: r, amount: amt, source, created_at: now() });
  audit({ actorUserId: userId, action: "recordPiecework", entityType: "piecework", entityId: pid, after: { worker: workerName, job: jobLabel, amount: amt }, source });
  return { pieceworkId: pid, worker: workerName, job: jobLabel, units: u, rate: r, amount: amt };
}

function getPendingPiecework(worker) {
  const cid = companyId();
  if (!cid) return { error: "Set up the workspace first." };
  const params = { cid };
  let where = "company_id=:cid AND paid=0";
  if (worker) { where += " AND lower(worker_name) LIKE :pat"; params.pat = `%${String(worker).toLowerCase()}%`; }
  const rows = all(`SELECT id, worker_name, job, units, rate, amount, created_at FROM piecework_entries WHERE ${where} ORDER BY created_at DESC LIMIT 100`, params);
  const totalByWorker = {};
  for (const r of rows) totalByWorker[r.worker_name] = (totalByWorker[r.worker_name] || 0) + Number(r.amount);
  return { entries: rows, totals_by_worker: totalByWorker, total_pending: rows.reduce((s, r) => s + Number(r.amount), 0) };
}

function markPieceworkPaid(pieceworkId, userId = null, source = "WEB") {
  const cid = companyId();
  if (!cid) throw new Error("Set up the workspace first.");
  const row = get("SELECT * FROM piecework_entries WHERE id=:id AND company_id=:cid", { id: pieceworkId, cid });
  if (!row) throw new Error("Piecework entry not found.");
  if (row.paid) return { pieceworkId, alreadyPaid: true };
  run("UPDATE piecework_entries SET paid=1, paid_at=:paid_at WHERE id=:id", { id: pieceworkId, paid_at: now() });
  // Also log as an expense so cashbook reflects reality.
  run("INSERT INTO expenses VALUES (:id,:cid,'WAGES',:desc,:amount,:user_id,:source,:created_at)",
    { id: id("exp"), cid, desc: `Piecework: ${row.worker_name} - ${row.job}`, amount: row.amount, user_id: userId, source, created_at: now() });
  audit({ actorUserId: userId, action: "markPieceworkPaid", entityType: "piecework", entityId: pieceworkId, after: { paid: true, amount: row.amount }, source });
  return { pieceworkId, worker: row.worker_name, amount: Number(row.amount), paid: true };
}

// Suggest a sale price. If a product name is given and past sales exist, we
// weight toward the recent median. Otherwise we fall back to a markup over the
// supplied material_cost + time cost. markup_pct defaults to 35% (typical Jua
// Kali margin for welded/fabricated goods).
function suggestPrice({ product, material_cost, time_hours, hourly_rate, markup_pct }) {
  const cid = companyId();
  if (!cid) return { error: "Set up the workspace first." };
  const prodName = String(product || "").trim();
  const past = prodName
    ? all("SELECT amount, quantity FROM sales_transactions WHERE company_id=:cid AND lower(item_name) LIKE :pat ORDER BY created_at DESC LIMIT 20",
          { cid, pat: `%${prodName.toLowerCase()}%` })
    : [];
  const unitPrices = past.map(p => Number(p.amount) / Math.max(1, Number(p.quantity))).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const median = unitPrices.length ? unitPrices[Math.floor(unitPrices.length / 2)] : null;
  const matCost = Math.max(0, Number(material_cost) || 0);
  const hours = Math.max(0, Number(time_hours) || 0);
  const rate = Math.max(0, Number(hourly_rate) || 500); // KSh 500/hr default fundi rate
  const markup = Math.max(0, Number(markup_pct) || 35);
  const costBasis = matCost + hours * rate;
  const costPlus = costBasis > 0 ? Math.round(costBasis * (1 + markup / 100)) : null;
  // Final suggestion: prefer the greater of median and cost-plus so we don't
  // underprice when materials get expensive.
  const candidates = [median, costPlus].filter(x => Number.isFinite(x) && x > 0);
  const suggested = candidates.length ? Math.round(Math.max(...candidates)) : null;
  return {
    product: prodName || "(unspecified)",
    past_sales_count: past.length,
    median_unit_price: median ? Math.round(median) : null,
    cost_basis: costBasis || null,
    cost_plus_price: costPlus,
    markup_pct_used: markup,
    hourly_rate_used: rate,
    suggested_price: suggested,
    confidence: past.length >= 5 ? "high" : past.length >= 2 ? "medium" : "low",
    note: !suggested ? "Need past sales OR material_cost+time_hours to suggest a price." : null
  };
}

// Daily cashbook: today's money in (sales + customer_payments) vs money out
// (expenses + purchases + supplier_payments). Pass date as 'YYYY-MM-DD' or
// omit for today. Returns the one-view "hesabu ya siku" summary.
function getDailyCashbook(date) {
  const cid = companyId();
  if (!cid) return { error: "Set up the workspace first." };
  const d = (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) ? String(date) : new Date().toISOString().slice(0, 10);
  const salesIn = get("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM sales_transactions WHERE company_id=:cid AND date(created_at)=:d", { cid, d });
  const custPayIn = get("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM debt_payments WHERE company_id=:cid AND debt_type='CUSTOMER' AND date(created_at)=:d", { cid, d });
  const expensesOut = get("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM expenses WHERE company_id=:cid AND date(created_at)=:d", { cid, d });
  const purchasesOut = get("SELECT COALESCE(SUM(total_cost),0) AS total, COUNT(*) AS n FROM purchases WHERE company_id=:cid AND date(created_at)=:d", { cid, d });
  const supPayOut = get("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM debt_payments WHERE company_id=:cid AND debt_type='SUPPLIER' AND date(created_at)=:d", { cid, d });
  const inflow = Number(salesIn.total) + Number(custPayIn.total);
  const outflow = Number(expensesOut.total) + Number(purchasesOut.total) + Number(supPayOut.total);
  return {
    date: d,
    inflow,
    outflow,
    net: inflow - outflow,
    breakdown: {
      sales: { total: Number(salesIn.total), count: salesIn.n },
      customer_payments: { total: Number(custPayIn.total), count: custPayIn.n },
      expenses: { total: Number(expensesOut.total), count: expensesOut.n },
      purchases: { total: Number(purchasesOut.total), count: purchasesOut.n },
      supplier_payments: { total: Number(supPayOut.total), count: supPayOut.n }
    }
  };
}

// Compose the end-of-day summary SMS text (Swahili + KSh). Short, feature-
// phone friendly: title, net, top three activities.
function generateDailySummary(language = "Swahili") {
  const cb = getDailyCashbook();
  if (cb.error) return { error: cb.error };
  const low = all(`SELECT item_name, quantity, reorder_level, unit FROM inventory
                   WHERE company_id=:cid AND reorder_level > 0 AND quantity <= reorder_level LIMIT 5`, { cid: companyId() });
  const fmt = n => "KSh " + Math.round(Number(n || 0)).toLocaleString();
  const sw = language === "Swahili";
  const label = sw ? "Hesabu ya leo" : "Today's cashbook";
  const parts = [
    `${label} (${cb.date})`,
    `${sw ? "Mapato" : "Inflow"}: ${fmt(cb.inflow)} · ${sw ? "Matumizi" : "Outflow"}: ${fmt(cb.outflow)}`,
    `${sw ? "Faida ya leo" : "Net"}: ${fmt(cb.net)}`,
    `${sw ? "Mauzo" : "Sales"}: ${cb.breakdown.sales.count} (${fmt(cb.breakdown.sales.total)})`
  ];
  if (low.length) {
    const items = low.map(i => `${i.item_name} ${i.quantity}${i.unit}`).join(", ");
    parts.push((sw ? "Stock chini: " : "Low stock: ") + items);
  }
  const text = parts.join("\n");
  return { date: cb.date, inflow: cb.inflow, outflow: cb.outflow, net: cb.net, low_stock: low, text };
}

// Dormant customers: those with no sale in the last N days (default 21). Jua
// Kali margin loss is often from forgotten regulars.
function getDormantCustomers(days = 21) {
  const cid = companyId();
  if (!cid) return { error: "Set up the workspace first." };
  const cutoff = Number(days) > 0 ? Number(days) : 21;
  const rows = all(`
    SELECT c.id, c.name, c.phone,
      (SELECT MAX(created_at) FROM sales_transactions s WHERE s.customer_id=c.id) AS last_sale,
      (SELECT COUNT(*) FROM sales_transactions s WHERE s.customer_id=c.id) AS total_sales
    FROM customers c WHERE c.company_id=:cid
    ORDER BY last_sale ASC NULLS LAST`, { cid });
  const nowMs = Date.now();
  const dormant = rows.filter(r => r.last_sale && (nowMs - new Date(r.last_sale).getTime()) >= cutoff * 86_400_000 && r.total_sales > 0);
  return { days: cutoff, count: dormant.length, customers: dormant.slice(0, 20) };
}

// Pricing anomalies: compare last 7 days' avg material cost vs the previous 7.
// If a material is up >= 15% we surface it (so the fundi can adjust bei ya kazi).
function getPricingAnomalies() {
  const cid = companyId();
  if (!cid) return { error: "Set up the workspace first." };
  const rows = all(`
    SELECT item_name,
      AVG(CASE WHEN created_at >= datetime('now','-7 days') THEN total_cost/NULLIF(quantity,0) END) AS recent_cost,
      AVG(CASE WHEN created_at <  datetime('now','-7 days') AND created_at >= datetime('now','-14 days') THEN total_cost/NULLIF(quantity,0) END) AS prior_cost
    FROM purchases WHERE company_id=:cid GROUP BY item_name`, { cid });
  const anomalies = [];
  for (const r of rows) {
    if (!r.recent_cost || !r.prior_cost) continue;
    const delta = (r.recent_cost - r.prior_cost) / r.prior_cost;
    if (Math.abs(delta) >= 0.15) {
      anomalies.push({
        material: r.item_name,
        recent_unit_cost: Math.round(r.recent_cost),
        prior_unit_cost: Math.round(r.prior_cost),
        change_pct: Math.round(delta * 100)
      });
    }
  }
  anomalies.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
  return { count: anomalies.length, anomalies };
}

// ========== ALERT GENERATION ==========
function generateBusinessAlerts() {
  const company = companyId();
  if (!company) return;

  // Check for low stock
  const lowStockItems = all("SELECT * FROM inventory WHERE company_id = :cid AND item_type = 'RAW_MATERIAL' AND quantity <= reorder_level", { cid: company });
  for (const item of lowStockItems) {
    const existingAlert = get("SELECT id FROM alerts WHERE company_id = :cid AND entity_type = 'inventory' AND entity_id = :eid AND status = 'OPEN'",
      { cid: company, eid: item.id });
    if (!existingAlert) {
      run("INSERT INTO alerts VALUES (:id,:company_id,:type,:severity,:title,:message,:status,:assigned_user_id,:entity_type,:entity_id,:created_at,:acknowledged_at)", {
        id: id("alert"), company_id: company, type: "LOW_STOCK", severity: "WARNING", title: `Low Stock: ${item.item_name}`,
        message: `${item.item_name} is at ${item.quantity}${item.unit} (reorder level: ${item.reorder_level}${item.unit}). Place an order.`,
        status: "OPEN", assigned_user_id: null, entity_type: "inventory", entity_id: item.id, created_at: now(), acknowledged_at: null
      });
    }
  }

  // Check for overdue customer debts
  const overdueDebts = all(`
    SELECT cd.*, c.name AS customer_name FROM customer_debts cd
    JOIN customers c ON c.id = cd.customer_id
    WHERE cd.company_id = :cid AND cd.status IN ('UNPAID', 'PARTIAL')
    AND cd.due_date < date('now')
  `, { cid: company });
  for (const debt of overdueDebts) {
    const existingAlert = get("SELECT id FROM alerts WHERE company_id = :cid AND entity_type = 'customer_debt' AND entity_id = :eid AND status = 'OPEN'",
      { cid: company, eid: debt.id });
    if (!existingAlert) {
      run("INSERT INTO alerts VALUES (:id,:company_id,:type,:severity,:title,:message,:status,:assigned_user_id,:entity_type,:entity_id,:created_at,:acknowledged_at)", {
        id: id("alert"), company_id: company, type: "OVERDUE_DEBT", severity: "CRITICAL", title: `Overdue Debt: ${debt.customer_name}`,
        message: `${debt.customer_name} owes KSh ${debt.amount_owed.toLocaleString()}. Due date: ${debt.due_date}. Follow up.`,
        status: "OPEN", assigned_user_id: null, entity_type: "customer_debt", entity_id: debt.id, created_at: now(), acknowledged_at: null
      });
    }
  }

  // Check for machines down
  const downMachines = all("SELECT * FROM machines WHERE company_id = :cid AND status = 'DOWN'", { cid: company });
  for (const machine of downMachines) {
    const existingAlert = get("SELECT id FROM alerts WHERE company_id = :cid AND entity_type = 'machine' AND entity_id = :eid AND status = 'OPEN'",
      { cid: company, eid: machine.id });
    if (!existingAlert) {
      run("INSERT INTO alerts VALUES (:id,:company_id,:type,:severity,:title,:message,:status,:assigned_user_id,:entity_type,:entity_id,:created_at,:acknowledged_at)", {
        id: id("alert"), company_id: company, type: "MACHINE_DOWN", severity: "CRITICAL", title: `Machine Down: ${machine.machine_no}`,
        message: `${machine.name} (${machine.machine_no}) is DOWN. Location: ${machine.location}. Assign technician.`,
        status: "OPEN", assigned_user_id: machine.technician_id || null, entity_type: "machine", entity_id: machine.id, created_at: now(), acknowledged_at: null
      });
    }
  }
}

function resetDemoData() {
  db.exec(`
    DELETE FROM debt_payments;
    DELETE FROM supplier_debts;
    DELETE FROM customer_debts;
    DELETE FROM expenses;
    DELETE FROM purchases;
    DELETE FROM sales_transactions;
    DELETE FROM suppliers;
    DELETE FROM audit_logs;
    DELETE FROM ai_actions;
    DELETE FROM ai_conversations;
    DELETE FROM notifications;
    DELETE FROM alerts;
    DELETE FROM payments;
    DELETE FROM invoices;
    DELETE FROM order_items;
    DELETE FROM orders;
    DELETE FROM customers;
    DELETE FROM maintenance_events;
    DELETE FROM downtime_events;
    DELETE FROM machines;
    DELETE FROM production_entries;
    DELETE FROM production_jobs;
    DELETE FROM inventory_transactions;
    DELETE FROM inventory;
    DELETE FROM materials;
    DELETE FROM products;
    DELETE FROM users;
    DELETE FROM companies;
  `);
  seed();
  return { reset: true, at: now() };
}

function audit({ actorUserId = null, action, entityType, entityId, before = null, after = null, source = "system" }) {
  run("INSERT INTO audit_logs VALUES (:id,:company_id,:actor_user_id,:action,:entity_type,:entity_id,:before_json,:after_json,:source,:created_at)", {
    id: id("audit"), company_id: companyId(), actor_user_id: actorUserId, action, entity_type: entityType, entity_id: entityId,
    before_json: before ? JSON.stringify(before) : null, after_json: after ? JSON.stringify(after) : null, source, created_at: now()
  });
}

function sendNotification({ channel, recipient, message, provider = "sandbox" }) {
  const nid = id("notif");
  const initialStatus = hasProviderCredentials(channel) ? "QUEUED" : "SANDBOX_SENT";
  run("INSERT INTO notifications VALUES (:id,:company_id,:channel,:recipient,:message,:status,:provider,:provider_ref,:created_at)", {
    id: nid, company_id: companyId(), channel, recipient, message, status: initialStatus, provider, provider_ref: `demo-${nid}`, created_at: now()
  });
  if (initialStatus === "QUEUED") dispatchNotification(nid).catch((err) => {
    run("UPDATE notifications SET status='FAILED', provider_ref=:ref WHERE id=:id", { id: nid, ref: err.message.slice(0, 180) });
  });
  return nid;
}

function hasProviderCredentials(channel) {
  if (channel === "SMS") return Boolean(process.env.AFRICASTALKING_USERNAME && process.env.AFRICASTALKING_API_KEY);
  if (channel === "VOICE") return Boolean(process.env.AFRICASTALKING_USERNAME && process.env.AFRICASTALKING_API_KEY && process.env.AFRICASTALKING_VOICE_NUMBER);
  return false;
}

function africasTalkingBase(kind) {
  const sandbox = (process.env.AFRICASTALKING_ENV || "sandbox") === "sandbox";
  if (kind === "voice") return sandbox ? "https://voice.sandbox.africastalking.com" : "https://voice.africastalking.com";
  return sandbox ? "https://api.sandbox.africastalking.com" : "https://api.africastalking.com";
}

async function dispatchNotification(notificationId) {
  const notif = get("SELECT * FROM notifications WHERE id=:id", { id: notificationId });
  if (!notif) return;
  if (notif.channel === "SMS") {
    const params = new URLSearchParams({
      username: process.env.AFRICASTALKING_USERNAME,
      to: notif.recipient,
      message: notif.message
    });
    if (process.env.AFRICASTALKING_SMS_SENDER_ID) params.set("from", process.env.AFRICASTALKING_SMS_SENDER_ID);
    const res = await fetch(`${africasTalkingBase("api")}/version1/messaging`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", apiKey: process.env.AFRICASTALKING_API_KEY },
      body: params
    });
    const text = await res.text();
    run("UPDATE notifications SET status=:status, provider_ref=:ref WHERE id=:id", { id: notificationId, status: res.ok ? "SENT" : "FAILED", ref: text.slice(0, 180) });
    return;
  }
  if (notif.channel === "VOICE") {
    const params = new URLSearchParams({
      username: process.env.AFRICASTALKING_USERNAME,
      from: process.env.AFRICASTALKING_VOICE_NUMBER,
      to: notif.recipient
    });
    const res = await fetch(`${africasTalkingBase("voice")}/call`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", apiKey: process.env.AFRICASTALKING_API_KEY },
      body: params
    });
    const text = await res.text();
    run("UPDATE notifications SET status=:status, provider_ref=:ref WHERE id=:id", { id: notificationId, status: res.ok ? "SENT" : "FAILED", ref: text.slice(0, 180) });
  }
}

function findUserByPhone(phone) {
  return get("SELECT * FROM users WHERE phone = :phone", { phone }) || get("SELECT * FROM users WHERE role = 'OPERATOR' LIMIT 1");
}

function normalizeItemName(value) {
  const v = String(value || "").toLowerCase();
  // Only translate Swahili/shorthand terms to known English equivalents
  if (/^(mlango|milango)$/.test(v) || v === "door") return "Steel Doors";
  if (/^(dirisha|madirisha)$/.test(v) || v === "window") return "Steel Windows";
  if (/^(chuma)$/.test(v) || v === "iron" || v === "metal") return "Steel";
  if (/^(rangi)$/.test(v)) return "Paint";
  if (/^(bawaba)$/.test(v)) return "Hinges";
  if (/^(misumari)$/.test(v)) return "Nails";
  if (/^(waya)$/.test(v)) return "Wire";
  if (/^(mbao)$/.test(v)) return "Timber";
  return value;
}

function findInventoryItem(itemName) {
  const raw = String(itemName || "").trim();
  const norm = normalizeItemName(raw);
  const cid = companyId();
  return get("SELECT * FROM inventory WHERE company_id = :cid AND (lower(item_name) = lower(:norm) OR lower(item_name) = lower(:raw) OR lower(item_name) LIKE :like) LIMIT 1",
    { cid, norm, raw, like: `%${raw.toLowerCase()}%` });
}

function consumeInventory({ itemName, quantity, unit, source, userId, productionJobId, note }) {
  const rawItem = String(itemName || "").trim();
  const inv = findInventoryItem(rawItem);
  if (!inv) throw new Error(`Inventory item not found: ${rawItem}. Configure it first.`);
  const before = Number(inv.quantity);
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) throw new Error("Quantity must be greater than zero");
  if (Number(quantity) > before) throw new Error(`${inv.item_name} stock is ${before}${inv.unit}; cannot consume ${quantity}${inv.unit}`);
  const after = before - Number(quantity);
  run("UPDATE inventory SET quantity = :quantity, updated_at = :updated_at WHERE id = :id", { quantity: after, updated_at: now(), id: inv.id });
  run("INSERT INTO inventory_transactions VALUES (:id,:company_id,:inventory_id,'CONSUME',:quantity,:before_qty,:after_qty,:source,:user_id,:production_job_id,:note,:created_at)", {
    id: id("itx"), company_id: companyId(), inventory_id: inv.id, quantity, before_qty: before, after_qty: after, source, user_id: userId || null, production_job_id: productionJobId || null, note: note || null, created_at: now()
  });
  audit({ actorUserId: userId, action: "consumeInventory", entityType: "inventory", entityId: inv.id, before: inv, after: { ...inv, quantity: after }, source });
  if (after <= Number(inv.reorder_level)) {
    const storekeeper = get("SELECT * FROM users WHERE role = 'STOREKEEPER' LIMIT 1");
    const message = `LOW STOCK ALERT: ${inv.item_name} is ${after}${inv.unit}. Reorder level is ${inv.reorder_level}${inv.unit}.`;
    const alertId = id("alert");
    run("INSERT INTO alerts VALUES (:id,:company_id,'LOW_STOCK','HIGH',:title,:message,'OPEN',:assigned_user_id,'inventory',:entity_id,:created_at,NULL)", {
      id: alertId, company_id: companyId(), title: "Low stock", message, assigned_user_id: storekeeper?.id || null, entity_id: inv.id, created_at: now()
    });
    const owner = get("SELECT * FROM users WHERE role = 'OWNER' LIMIT 1");
    if (storekeeper) sendNotification({ channel: "SMS", recipient: storekeeper.phone, message, provider: "africastalking" });
    if (owner && owner.phone !== storekeeper?.phone) sendNotification({ channel: "SMS", recipient: owner.phone, message, provider: "africastalking" });
  }
  return get("SELECT * FROM inventory WHERE id = :id", { id: inv.id });
}

function addInventory({ itemName, quantity, source, userId, productionJobId, note }) {
  const inv = findInventoryItem(itemName);
  if (!inv) throw new Error(`Inventory item not found: ${itemName}`);
  const before = Number(inv.quantity);
  const after = before + Number(quantity);
  run("UPDATE inventory SET quantity = :quantity, updated_at = :updated_at WHERE id = :id", { quantity: after, updated_at: now(), id: inv.id });
  run("INSERT INTO inventory_transactions VALUES (:id,:company_id,:inventory_id,'ADD',:quantity,:before_qty,:after_qty,:source,:user_id,:production_job_id,:note,:created_at)", {
    id: id("itx"), company_id: companyId(), inventory_id: inv.id, quantity, before_qty: before, after_qty: after, source, user_id: userId || null, production_job_id: productionJobId || null, note: note || null, created_at: now()
  });
  audit({ actorUserId: userId, action: "addInventory", entityType: "inventory", entityId: inv.id, before: inv, after: { ...inv, quantity: after }, source });
  return get("SELECT * FROM inventory WHERE id = :id", { id: inv.id });
}

function createProductionEntry({ productName, quantityProduced, materialName, quantityConsumed, unit, source, userId, originalMessage, structured }) {
  const normProductName = normalizeItemName(productName);
  const product = get("SELECT * FROM products WHERE company_id=:cid AND (lower(name) = lower(:name) OR lower(name) LIKE :like) LIMIT 1",
    { cid: companyId(), name: normProductName, like: `%${normProductName.toLowerCase()}%` });
  if (!product) throw new Error(`Product not found: ${productName}. Add the product in Setup first.`);
  if (!Number.isFinite(Number(quantityProduced)) || Number(quantityProduced) <= 0) throw new Error("Production quantity must be greater than zero.");
  const finishedInventory = findInventoryItem(product.name);
  if (!finishedInventory) throw new Error(`Finished product inventory not found: ${product.name}`);
  if (materialName && Number(quantityConsumed) > 0) {
    const materialInventory = findInventoryItem(materialName);
    if (!materialInventory) throw new Error(`Inventory item not found: ${materialName}`);
    const material = get("SELECT quantity, unit FROM inventory WHERE id=:id", { id: materialInventory.id });
    if (Number(quantityConsumed) > Number(material.quantity)) throw new Error(`${materialName} stock is ${material.quantity}${material.unit}; cannot consume ${quantityConsumed}${material.unit}`);
  }
  const job = get("SELECT * FROM production_jobs WHERE product_id = :pid AND status IN ('PENDING','IN_PROGRESS') ORDER BY created_at DESC LIMIT 1", { pid: product.id });
  if (materialName && quantityConsumed) consumeInventory({ itemName: materialName, quantity: quantityConsumed, unit, source, userId, productionJobId: job?.id, note: originalMessage });
  const finished = addInventory({ itemName: product.name, quantity: quantityProduced, source, userId, productionJobId: job?.id, note: originalMessage });
  const completed = Number(job?.completed_qty || 0) + Number(quantityProduced);
  if (job) {
    const status = completed >= Number(job.target_qty) ? "COMPLETED" : "IN_PROGRESS";
    run("UPDATE production_jobs SET completed_qty = :completed_qty, status = :status, updated_at = :updated_at WHERE id = :id", { completed_qty: completed, status, updated_at: now(), id: job.id });
  }
  const peid = id("prod");
  run("INSERT INTO production_entries VALUES (:id,:company_id,:production_job_id,:product_id,:product_name,:quantity_produced,:operator_id,:source,:original_message,:structured_json,:created_at)", {
    id: peid, company_id: companyId(), production_job_id: job?.id || null, product_id: product.id, product_name: product.name,
    quantity_produced: quantityProduced, operator_id: userId, source, original_message: originalMessage || null, structured_json: JSON.stringify(structured || {}), created_at: now()
  });
  audit({ actorUserId: userId, action: "createProductionEntry", entityType: "production_entry", entityId: peid, after: structured, source });
  return { entryId: peid, jobId: job?.id, product: product.name, quantityProduced, inventory: finished };
}

function createSale({ itemName, quantity, unit = "kg", amount, customer, paymentStatus = "PAID", source, userId, originalMessage, structured }) {
  if (!companyId()) throw new Error("Configure the business workspace before recording a sale.");
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) throw new Error("Sale quantity must be greater than zero.");
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error("Sale amount must be greater than zero.");
  const inventory = consumeInventory({ itemName, quantity: Number(quantity), unit, source, userId, note: originalMessage });
  const saleId = id("sale");
  // Resolve or create customer
  let customerId = null;
  let customerName = customer ? String(customer).trim() : null;
  if (customerName) {
    const existing = findCustomer(customerName);
    if (existing) {
      customerId = existing.id;
      customerName = existing.name;
    } else {
      customerId = id("cust");
      run("INSERT INTO customers VALUES (:id,:company_id,:name,:phone,:created_at)", { id: customerId, company_id: companyId(), name: customerName, phone: null, created_at: now() });
    }
  }
  run("INSERT INTO sales_transactions (id,company_id,item_name,quantity,unit,amount,customer_id,customer_name,payment_status,source,user_id,original_message,created_at) VALUES (:id,:company_id,:item_name,:quantity,:unit,:amount,:customer_id,:customer_name,:payment_status,:source,:user_id,:original_message,:created_at)", {
    id: saleId, company_id: companyId(), item_name: inventory.item_name, quantity: Number(quantity), unit: inventory.unit,
    amount: Number(amount), customer_id: customerId, customer_name: customerName, payment_status: paymentStatus || "PAID",
    source, user_id: userId, original_message: originalMessage || null, created_at: now()
  });
  // Create customer debt if sale is on credit
  if (paymentStatus === "CREDIT" && customerId) {
    createCustomerDebt({ customerId, saleId, amountOwed: Number(amount), source });
  }
  audit({ actorUserId: userId, action: "createSale", entityType: "sale", entityId: saleId, after: { itemName: inventory.item_name, quantity, amount, customer: customerName }, source });
  return { saleId, itemName: inventory.item_name, quantity: Number(quantity), unit: inventory.unit, amount: Number(amount), remaining: inventory.quantity, customer: customerName, paymentStatus };
}

function recordPurchase({ supplierName, itemName, quantity, unit = "kg", totalCost, paymentStatus = "PAID", source = "WEB", userId = null, originalMessage = null }) {
  if (!companyId()) throw new Error("Configure the business workspace before recording purchases.");
  if (!itemName) throw new Error("Item name is required for a purchase.");
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) throw new Error("Purchase quantity must be greater than zero.");
  if (!Number.isFinite(Number(totalCost)) || Number(totalCost) <= 0) throw new Error("Purchase cost must be greater than zero.");
  // Resolve or create supplier
  let supplierId = null;
  let resolvedSupplierName = supplierName ? String(supplierName).trim() : null;
  if (resolvedSupplierName) {
    const existing = findSupplier(resolvedSupplierName);
    if (existing) {
      supplierId = existing.id;
      resolvedSupplierName = existing.name;
    } else {
      const added = addSupplier({ name: resolvedSupplierName, source });
      supplierId = added.supplierId;
    }
  }
  // Add to inventory
  const inv = findInventoryItem(itemName);
  if (!inv) throw new Error(`Inventory item not found: ${itemName}. Configure it as a material first.`);
  addInventory({ itemName: inv.item_name, quantity: Number(quantity), source, userId, note: originalMessage || `Purchased from ${resolvedSupplierName || 'supplier'}` });
  // Record purchase
  const purchaseId = id("pur");
  run("INSERT INTO purchases VALUES (:id,:company_id,:supplier_id,:supplier_name,:item_name,:quantity,:unit,:total_cost,:payment_status,:source,:user_id,:original_message,:created_at)", {
    id: purchaseId, company_id: companyId(), supplier_id: supplierId, supplier_name: resolvedSupplierName,
    item_name: inv.item_name, quantity: Number(quantity), unit: inv.unit || unit, total_cost: Number(totalCost),
    payment_status: paymentStatus, source, user_id: userId, original_message: originalMessage || null, created_at: now()
  });
  // Create supplier debt if on credit
  if (paymentStatus === "CREDIT" && supplierId) {
    createSupplierDebt({ supplierId, purchaseId, amountOwed: Number(totalCost), source });
  }
  audit({ actorUserId: userId, action: "recordPurchase", entityType: "purchase", entityId: purchaseId, after: { itemName: inv.item_name, quantity, totalCost, supplier: resolvedSupplierName }, source });
  return { purchaseId, itemName: inv.item_name, quantity: Number(quantity), unit: inv.unit || unit, totalCost: Number(totalCost), supplier: resolvedSupplierName, paymentStatus };
}

function listPurchases(period = "all") {
  const company = companyId();
  let sql = "SELECT * FROM purchases WHERE company_id = :cid";
  if (period === "today") sql += " AND date(created_at) = date('now')";
  else if (period === "week") sql += " AND created_at >= datetime('now', '-7 days')";
  else if (period === "month") sql += " AND created_at >= datetime('now', '-30 days')";
  return all(sql + " ORDER BY created_at DESC", { cid: company });
}

function createDowntime({ machineName, source, userId, originalMessage, structured }) {
  const machineNo = /(\d+)/.exec(machineName || "")?.[1];
  const machine = get("SELECT * FROM machines WHERE lower(machine_no) = lower(:name) OR lower(name) = lower(:name) OR machine_no LIKE :like LIMIT 1", {
    name: machineName || "Machine 2", like: `%${machineNo || "2"}%`
  }) || get("SELECT * FROM machines WHERE machine_no = 'Machine 2'");
  run("UPDATE machines SET status = 'DOWN', updated_at = :updated_at WHERE id = :id", { id: machine.id, updated_at: now() });
  const eventId = id("down");
  run("INSERT INTO downtime_events VALUES (:id,:company_id,:machine_id,'OPEN',:reported_by,:technician_id,NULL,NULL,NULL,0,:source,:original_message,:created_at)", {
    id: eventId, company_id: companyId(), machine_id: machine.id, reported_by: userId, technician_id: machine.technician_id, source, original_message: originalMessage || null, created_at: now()
  });
  run("INSERT INTO maintenance_events VALUES (:id,:company_id,:machine_id,'DOWNTIME_REPORTED',:note,:technician_id,:created_at)", {
    id: id("maint"), company_id: companyId(), machine_id: machine.id, note: originalMessage || "Machine reported down", technician_id: machine.technician_id, created_at: now()
  });
  const tech = machine.technician_id ? get("SELECT * FROM users WHERE id = :id", { id: machine.technician_id }) : null;
  const msg = `MACHINE DOWN: ${machine.machine_no} ${machine.name}. Please acknowledge maintenance incident ${eventId}.`;
  if (tech) sendNotification({ channel: "SMS", recipient: tech.phone, message: msg, provider: "africastalking" });
  const supervisor = get("SELECT * FROM users WHERE role = 'SUPERVISOR' LIMIT 1") || get("SELECT * FROM users WHERE role = 'MANAGER' LIMIT 1");
  const alertId = id("alert");
  run("INSERT INTO alerts VALUES (:id,:company_id,'MACHINE_DOWN','CRITICAL',:title,:message,'OPEN',:assigned_user_id,'downtime_event',:entity_id,:created_at,NULL)", {
    id: alertId, company_id: companyId(), title: "Machine down", message: msg, assigned_user_id: tech?.id || supervisor?.id || null, entity_id: eventId, created_at: now()
  });
  audit({ actorUserId: userId, action: "createDowntime", entityType: "downtime_event", entityId: eventId, after: structured, source });
  return { eventId, machine: machine.machine_no, technician: tech?.name || "Unassigned" };
}

function escalateDowntime(eventId) {
  const ev = get("SELECT de.*, m.machine_no, m.name AS machine_name FROM downtime_events de JOIN machines m ON m.id = de.machine_id WHERE de.id = :id", { id: eventId });
  if (!ev || ev.acknowledged_at || ev.resolved_at) return { skipped: true };
  const newLevel = Number(ev.escalation_level) + 1;
  run("UPDATE downtime_events SET escalation_level = :level WHERE id = :id", { level: newLevel, id: eventId });
  const targetRole = newLevel === 1 ? "TECHNICIAN" : newLevel === 2 ? "MANAGER" : "OWNER";
  const user = get("SELECT * FROM users WHERE role = :role LIMIT 1", { role: targetRole }) || get("SELECT * FROM users WHERE role = 'OWNER' LIMIT 1");
  const message = `VOICE ESCALATION: ${ev.machine_no} ${ev.machine_name} is still down. Incident ${eventId} needs action.`;
  sendNotification({ channel: "VOICE", recipient: user.phone, message, provider: "africastalking" });
  return { eventId, escalationLevel: newLevel, called: user.name };
}

function resolveMaintenance(eventId, userId) {
  const ev = get("SELECT * FROM downtime_events WHERE id = :id", { id: eventId });
  if (!ev) throw new Error("Downtime event not found");
  const minutes = Math.max(1, Math.round((Date.now() - new Date(ev.created_at).getTime()) / 60000));
  run("UPDATE downtime_events SET status='RESOLVED', acknowledged_at = COALESCE(acknowledged_at, :now), resolved_at=:now, downtime_minutes=:minutes WHERE id=:id", { now: now(), minutes, id: eventId });
  run("UPDATE machines SET status='RUNNING', total_downtime_minutes = total_downtime_minutes + :minutes, updated_at=:now WHERE id=:id", { minutes, now: now(), id: ev.machine_id });
  run("INSERT INTO maintenance_events VALUES (:id,:company_id,:machine_id,'REPAIRED',:note,:technician_id,:created_at)", {
    id: id("maint"), company_id: companyId(), machine_id: ev.machine_id, note: `Resolved after ${minutes} minutes`, technician_id: userId, created_at: now()
  });
  audit({ actorUserId: userId, action: "resolveMaintenance", entityType: "downtime_event", entityId: eventId, after: { minutes }, source: "web" });
  return { eventId, minutes };
}

function createOrder({ customerId, productId, quantity, source = "web" }) {
  const product = get("SELECT * FROM products WHERE id = :id", { id: productId });
  const orderId = id("ord");
  const invoiceId = id("inv");
  const amount = Number(product.selling_price) * Number(quantity);
  const count = get("SELECT COUNT(*) AS c FROM orders").c + 1001;
  run("INSERT INTO orders VALUES (:id,:company_id,:order_no,:customer_id,'IN_PRODUCTION',:total_amount,:created_at,:updated_at)", {
    id: orderId, company_id: companyId() || "co_biashara", order_no: `ORD-${count}`, customer_id: customerId, total_amount: amount, created_at: now(), updated_at: now()
  });
  run("INSERT INTO order_items VALUES (:id,:order_id,:product_id,:product_name,:quantity,:unit_price)", {
    id: id("oi"), order_id: orderId, product_id: productId, product_name: product.name, quantity, unit_price: product.selling_price
  });
  run("INSERT INTO invoices VALUES (:id,:company_id,:invoice_no,:order_id,:amount,'UNPAID',:issued_at,NULL)", {
    id: invoiceId, company_id: companyId() || "co_biashara", invoice_no: `INV-${count}`, order_id: orderId, amount, issued_at: now()
  });
  audit({ action: "createOrder", entityType: "order", entityId: orderId, after: { product: product.name, quantity, amount }, source });
  return { orderId, invoiceId, amount };
}

function setupWorkspace(data = {}) {
  const companyName = String(data.companyName || "").trim();
  const city = String(data.city || "").trim();
  const ownerName = String(data.ownerName || "").trim();
  const ownerPhone = String(data.ownerPhone || "").trim();
  if (!companyName || !city || !ownerName || !ownerPhone) throw new Error("Company, city, owner name, and owner phone are required");
  if (get("SELECT id FROM companies LIMIT 1")) throw new Error("Workspace is already configured");
  const t = now();
  const cid = id("co");
  run("INSERT INTO companies VALUES (:id,:name,:city,:created_at)", { id: cid, name: companyName, city, created_at: t });
  run("INSERT INTO users VALUES (:id,:company_id,:name,:phone,'OWNER',:created_at)", { id: id("usr"), company_id: cid, name: ownerName, phone: ownerPhone, created_at: t });
  if (String(data.productName || "").trim()) {
    const productId = id("prod");
    const productName = String(data.productName).trim();
    const unit = String(data.productUnit || "units").trim() || "units";
    run("INSERT INTO products VALUES (:id,:company_id,:sku,:name,:unit,:selling_price,:created_at)", { id: productId, company_id: cid, sku: String(data.productSku || productName.slice(0, 8).toUpperCase()), name: productName, unit, selling_price: Number(data.productPrice || 0), created_at: t });
    run("INSERT INTO inventory VALUES (:id,:company_id,'FINISHED_GOOD',:item_id,:item_name,:unit,0,0,:updated_at)", { id: id("inv"), company_id: cid, item_id: productId, item_name: productName, unit, updated_at: t });
  }
  if (String(data.materialName || "").trim()) {
    const materialId = id("mat");
    const materialName = String(data.materialName).trim();
    const unit = String(data.materialUnit || "kg").trim() || "kg";
    run("INSERT INTO materials VALUES (:id,:company_id,:name,:unit,:supplier,:reorder_level,:created_at)", { id: materialId, company_id: cid, name: materialName, unit, supplier: String(data.supplier || "").trim(), reorder_level: Number(data.reorderLevel || 0), created_at: t });
    run("INSERT INTO inventory VALUES (:id,:company_id,'RAW_MATERIAL',:item_id,:item_name,:unit,:quantity,:reorder_level,:updated_at)", { id: id("inv"), company_id: cid, item_id: materialId, item_name: materialName, unit, quantity: Number(data.materialQuantity || 0), reorder_level: Number(data.reorderLevel || 0), updated_at: t });
  }
  return { configured: true, company: get("SELECT id, name, city FROM companies WHERE id=:id", { id: cid }) };
}

// A new Google workspace starts with just its company and owner, so the
// dashboard has a business to attach records to.
function createStarterCompany(ownerName) {
  if (companyId()) return;
  const t = now();
  const cid = id("co");
  const firstName = String(ownerName || "").trim().split(/\s+/)[0] || "My";
  run("INSERT INTO companies VALUES (:id,:name,:city,:created_at)", { id: cid, name: `${firstName}'s Business`, city: "Kenya", created_at: t });
  run("INSERT INTO users VALUES (:id,:company_id,:name,:phone,'OWNER',:created_at)", { id: id("usr"), company_id: cid, name: String(ownerName || "Owner").slice(0, 120), phone: "", created_at: t });
}

// Sends the sign-in code through Brevo's HTTPS API (SMTP ports are blocked on
// Render's free plan, so plain Gmail SMTP would never deliver from there).
async function sendLoginCodeEmail(email, code) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME },
      to: [{ email }],
      subject: `${code} is your Biashara OS sign-in code`,
      textContent: `Your Biashara OS sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.`,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px">
        <h2 style="margin:0 0 8px;color:#14532d">Biashara OS</h2>
        <p style="margin:0 0 16px;color:#334155">Your sign-in code is:</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:0 0 16px;color:#0f172a">${code}</p>
        <p style="margin:0;color:#64748b;font-size:13px">It expires in 10 minutes. If you did not ask for it, ignore this email.</p>
      </div>`
    })
  });
  if (!res.ok) throw new Error(`Brevo responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

// Asks Google to check the ID token's signature and expiry, then checks it was
// issued for this app and carries a verified email.
async function verifyGoogleIdToken(credential) {
  const fail = (message) => Object.assign(new Error(message), { status: 401 });
  if (!GOOGLE_CLIENT_ID) throw Object.assign(new Error("Google sign-in is not configured"), { status: 503 });
  if (typeof credential !== "string" || !credential || credential.length > 4096) throw fail("Missing Google credential");
  let res;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw Object.assign(new Error("Could not reach Google. Try again."), { status: 502 });
  }
  if (!res.ok) throw fail("Google sign-in was rejected");
  const claims = await res.json();
  if (claims.aud !== GOOGLE_CLIENT_ID) throw fail("Google sign-in was issued for a different app");
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw fail("Google sign-in has an unexpected issuer");
  if (Number(claims.exp) * 1000 < Date.now()) throw fail("Google sign-in has expired");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw fail("Your Google email is not verified");
  return claims;
}

function setupWorkspaceFromAgent(data = {}) {
  if (companyId()) throw new Error("Workspace is already configured.");
  return withTransaction(() => setupWorkspace(data));
}

function configureRecord({ target, name, unit, quantity = 0, reorderLevel = 0, supplier = "", sku = "", price = 0, machineNo = "", location = "", phone = "", targetQty = 0, source = "AI", userId = null, originalMessage = "", structured = {} }) {
  const type = String(target || "").toLowerCase().replace(/[ -]/g, "_");
  if (!companyId()) throw new Error("Configure the workspace first before adding module records.");
  const recordName = String(name || "").trim();
  if (!recordName) throw new Error(`A name is required to configure ${type || "this record"}.`);
  const t = now();
  let result;
  if (["material", "inventory", "raw_material"].includes(type)) {
    const materialId = id("mat");
    const materialUnit = String(unit || "kg").trim();
    const stock = Number(quantity);
    const reorder = Number(reorderLevel);
    if (!Number.isFinite(stock) || stock < 0 || !Number.isFinite(reorder) || reorder < 0) throw new Error("Material quantity and reorder level must be zero or greater.");
    run("INSERT INTO materials VALUES (:id,:company_id,:name,:unit,:supplier,:reorder_level,:created_at)", { id: materialId, company_id: companyId(), name: recordName, unit: materialUnit, supplier: String(supplier || "").trim() || null, reorder_level: reorder, created_at: t });
    const inventoryId = id("inv");
    run("INSERT INTO inventory VALUES (:id,:company_id,'RAW_MATERIAL',:item_id,:item_name,:unit,:quantity,:reorder_level,:updated_at)", { id: inventoryId, company_id: companyId(), item_id: materialId, item_name: recordName, unit: materialUnit, quantity: stock, reorder_level: reorder, updated_at: t });
    result = { target: "material", id: materialId, name: recordName, quantity: stock, unit: materialUnit };
  } else if (type === "product") {
    const productId = id("prod");
    const productUnit = String(unit || "units").trim();
    const initialStock = Number(quantity);
    if (!Number.isFinite(initialStock) || initialStock < 0) throw new Error("Product opening stock must be zero or greater.");
    run("INSERT INTO products VALUES (:id,:company_id,:sku,:name,:unit,:selling_price,:created_at)", { id: productId, company_id: companyId(), sku: String(sku || recordName.slice(0, 8).toUpperCase()).trim(), name: recordName, unit: productUnit, selling_price: Number(price) || 0, created_at: t });
    run("INSERT INTO inventory VALUES (:id,:company_id,'FINISHED_GOOD',:item_id,:item_name,:unit,:quantity,0,:updated_at)", { id: id("inv"), company_id: companyId(), item_id: productId, item_name: recordName, unit: productUnit, quantity: initialStock, updated_at: t });
    result = { target: "product", id: productId, name: recordName, quantity: initialStock, unit: productUnit };
  } else if (type === "machine") {
    const number = String(machineNo || recordName).trim();
    run("INSERT INTO machines VALUES (:id,:company_id,:machine_no,:name,:location,'IDLE',NULL,NULL,NULL,NULL,0,:updated_at)", { id: id("mach"), company_id: companyId(), machine_no: number, name: recordName, location: String(location || "Factory floor").trim(), updated_at: t });
    result = { target: "machine", machineNo: number, name: recordName };
  } else if (type === "customer") {
    const customerId = id("cust");
    run("INSERT INTO customers VALUES (:id,:company_id,:name,:phone,:created_at)", { id: customerId, company_id: companyId(), name: recordName, phone: String(phone || "").trim() || null, created_at: t });
    result = { target: "customer", id: customerId, name: recordName };
  } else if (["production_job", "job"].includes(type)) {
    const product = get("SELECT * FROM products WHERE lower(name)=lower(:name) LIMIT 1", { name: recordName });
    const target = Number(targetQty || quantity);
    if (!product) throw new Error(`Product not found: ${recordName}. Configure the product first.`);
    if (!Number.isFinite(target) || target <= 0) throw new Error("Production target must be greater than zero.");
    const jobId = id("job");
    run("INSERT INTO production_jobs VALUES (:id,:company_id,:job_no,:product_id,:product_name,:target_qty,0,'PENDING',NULL,NULL,:created_at,:updated_at)", { id: jobId, company_id: companyId(), job_no: `JOB-${Date.now().toString().slice(-6)}`, product_id: product.id, product_name: product.name, target_qty: target, created_at: t, updated_at: t });
    result = { target: "production_job", id: jobId, product: product.name, targetQty: target };
  } else {
    throw new Error("I can configure materials, products, machines, customers, and production jobs. Provider credentials must be configured outside chat.");
  }
  audit({ actorUserId: userId, action: "configureRecord", entityType: type, entityId: result.id || result.machineNo, after: { ...result, originalMessage }, source });
  return result;
}

function recordPayment({ invoiceId, amount, reference, rawPayload }) {
  const inv = get("SELECT * FROM invoices WHERE id = :id", { id: invoiceId }) || get("SELECT * FROM invoices WHERE status = 'UNPAID' ORDER BY issued_at DESC LIMIT 1");
  if (!inv) throw new Error("No invoice available for payment");
  run("INSERT INTO payments VALUES (:id,:company_id,:invoice_id,'MPESA',:amount,:reference,'CONFIRMED',:raw_payload,:created_at)", {
    id: id("pay"), company_id: companyId(), invoice_id: inv.id, amount: amount || inv.amount, reference: reference || `MPESA-${Date.now()}`, raw_payload: JSON.stringify(rawPayload || {}), created_at: now()
  });
  run("UPDATE invoices SET status='PAID', paid_at=:paid_at WHERE id=:id", { paid_at: now(), id: inv.id });
  run("UPDATE orders SET status='COMPLETED', updated_at=:updated_at WHERE id=:id", { updated_at: now(), id: inv.order_id });
  const accountant = get("SELECT * FROM users WHERE role = 'ACCOUNTANT' LIMIT 1");
  if (accountant) sendNotification({ channel: "SMS", recipient: accountant.phone, message: `PAYMENT RECEIVED: KSh ${Number(amount || inv.amount).toLocaleString()} for ${inv.invoice_no}.`, provider: "africastalking" });
  audit({ action: "recordPayment", entityType: "invoice", entityId: inv.id, after: { status: "PAID", amount: amount || inv.amount }, source: "mpesa" });
  return { invoiceId: inv.id, status: "PAID", amount: amount || inv.amount };
}

function darajaBase() {
  return (process.env.MPESA_ENV || "sandbox") === "sandbox" ? "https://sandbox.safaricom.co.ke" : "https://api.safaricom.co.ke";
}

async function darajaToken() {
  if (!process.env.MPESA_CONSUMER_KEY || !process.env.MPESA_CONSUMER_SECRET) throw new Error("Daraja credentials are not configured");
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");
  const res = await fetch(`${darajaBase()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.error || "Daraja token request failed");
  return data.access_token;
}

async function initiateStkPush({ phone, amount, invoiceId }) {
  if (!process.env.MPESA_SHORTCODE || !process.env.MPESA_PASSKEY || !process.env.MPESA_CALLBACK_URL) throw new Error("Daraja STK Push environment variables are not configured");
  const token = await darajaToken();
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString("base64");
  const payload = {
    BusinessShortCode: Number(process.env.MPESA_SHORTCODE),
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(Number(amount)),
    PartyA: Number(String(phone).replace(/^\+/, "")),
    PartyB: Number(process.env.MPESA_SHORTCODE),
    PhoneNumber: Number(String(phone).replace(/^\+/, "")),
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: invoiceId,
    TransactionDesc: "Biashara OS invoice payment"
  };
  const res = await fetch(`${darajaBase()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.error || "Daraja STK Push failed");
  audit({ action: "initiateStkPush", entityType: "invoice", entityId: invoiceId, after: data, source: "mpesa" });
  return data;
}

function parseBiasharaMessage(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const numWords = {
    moja: 1, mmoja: 1, moja: 1,
    mbili: 2, miwili: 2, mawili: 2,
    tatu: 3, mitatu: 3, matatu: 3,
    nne: 4, minne: 4, manne: 4,
    tano: 5, mitano: 5, matano: 5,
    sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10
  };
  const toNum = (v) => Number(v) || numWords[String(v).toLowerCase()] || 0;
  if (/(imetumia|nimetumia|used|consume)/.test(lower) && /(kutengeneza|produced|made|tengeneza)/.test(lower)) {
    const consumed = /(?:kilo|kg|lita|l|pcs)?\s*(\d+(?:\.\d+)?)/.exec(lower);
    const qtyConsumed = Number(consumed?.[1] || 0);
    const material = /(chuma|steel|paint|rangi|hinges|bawaba)/.exec(lower)?.[1] || "steel";
    const qtyWord = "\\d+|moja|mmoja|mbili|miwili|mawili|tatu|mitatu|matatu|nne|minne|manne|tano|mitano|matano|sita|saba|nane|tisa|kumi";
    const producedAfter = new RegExp(`(?:milango|doors?|madirisha|windows?)\\s*(${qtyWord})`).exec(lower);
    const producedBefore = new RegExp(`(${qtyWord})\\s*(?:milango|doors?|madirisha|windows?)`).exec(lower);
    const product = /(milango|mlango|door)/.test(lower) ? "Steel Doors" : /(dirisha|window)/.test(lower) ? "Steel Windows" : "Steel Doors";
    return { intent: "production_update", material: normalizeItemName(material), quantity_consumed: qtyConsumed, unit: /paint|rangi|lita|\sl\b/.test(lower) ? "L" : "kg", product, quantity_produced: toNum(producedAfter?.[1] || producedBefore?.[1] || 1) };
  }
  const saleAmountPattern = "(?:ksh|kes|kenyan\\s+shillings?|shillings?)?\\s*([\\d,]+(?:\\.\\d+)?)";
  const saleItemPattern = "((?:metal\\s+)?(?:steel|iron|metal|chuma|paint|rangi|hinges|bawaba|nails?|misumari|bolts?|nuts?|screws?|wire|waya|timber|wood|mbao|alumin(?:um|ium)))";
  const salePrefix = "(?:record(?:\\s+that)?\\s+)?(?:i\\s+have\\s+)?(?:sold|sell|nimeuza|imeuza|imeuzwa)";
  const saleMatch = new RegExp(`${salePrefix}\\s+(\\d+(?:\\.\\d+)?)\\s*(kg|kilos?|l|litres?|pcs|pieces?)?\\s*(?:of|ya|za)?\\s*${saleItemPattern}\\s*(?:for|kwa|at)\\s*${saleAmountPattern}`, "i").exec(text);
  if (saleMatch) {
    return { intent: "sale", item: saleMatch[3], quantity: Number(saleMatch[1]), unit: /l|litre/i.test(saleMatch[2] || "") ? "L" : /pcs|piece/i.test(saleMatch[2] || "") ? "pcs" : "kg", amount: Number(saleMatch[4].replace(/,/g, "")) };
  }
  const saleDetails = new RegExp(`${salePrefix}\\s+(\\d+(?:\\.\\d+)?)\\s*(kg|kilos?|l|litres?|pcs|pieces?)?\\s*(?:of|ya|za)?\\s*${saleItemPattern}`, "i").exec(text);
  if (saleDetails) {
    return { intent: "sale_missing_details", item: normalizeItemName(saleDetails[3]), quantity: Number(saleDetails[1]), unit: /l|litre/i.test(saleDetails[2] || "") ? "L" : /pcs|piece/i.test(saleDetails[2] || "") ? "pcs" : "kg" };
  }
  const configuration = /(?:configure|add|create|setup|set up|register)\s+(.+?)\s+(?:as|to)\s+(?:a\s+)?(raw material|material|product|machine|customer|production job)/i.exec(text);
  if (configuration) {
    const name = configuration[1].replace(/\s*,.*$/, "").trim();
    const target = configuration[2].toLowerCase().replace(/\s+/g, "_");
    const unit = /unit\s+(kg|kilos?|litres?|l|pcs|pieces?|units?)/i.exec(text)?.[1] || /\b(kg|kilos?|litres?|l|pcs|pieces?|units?)\b/i.exec(text)?.[1] || (target === "machine" ? "units" : target === "product" ? "units" : "kg");
    const quantity = /(?:opening\s+quantity|quantity|stock)\s*(?:is|of|:)?\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1] || 0;
    const reorderLevel = /(?:reorder\s+level|minimum|threshold)\s*(?:is|of|:)?\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1] || 0;
    const price = /(?:price|selling\s+price)\s*(?:is|of|:)?\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1] || 0;
    const targetQty = /(?:target|quantity)\s*(?:is|of|:)?\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1] || quantity;
    return { intent: "configure", target, name, unit: /litre/i.test(unit) ? "L" : /^kilos?$/i.test(unit) ? "kg" : unit, quantity: Number(quantity), reorderLevel: Number(reorderLevel), price: Number(price), targetQty: Number(targetQty) };
  }
  const standaloneSale = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(kg|kilos?|l|litres?|pcs|pieces?)?\\s*(?:of|ya|za)\\s*${saleItemPattern}$`, "i").exec(text);
  if (standaloneSale) {
    return { intent: "sale_missing_details", item: normalizeItemName(standaloneSale[3]), quantity: Number(standaloneSale[1]), unit: /l|litre/i.test(standaloneSale[2] || "") ? "L" : /pcs|piece/i.test(standaloneSale[2] || "") ? "pcs" : "kg" };
  }
  if (/(imeharibika|broken|down|fault|haribika)/.test(lower) && /(machine|mashine)/.test(lower)) {
    const m = /(machine|mashine)\s*(\d+)/.exec(lower);
    return { intent: "machine_downtime", machine: `Machine ${m?.[2] || 2}`, event: "Downtime", status: "DOWN" };
  }
  // ---- EXPENSE PATTERNS ----
  // ---- PURCHASE PATTERNS ----
  const purchaseSimple = /(?:nimenunua|namenunua|bought|purchased)\s+(.+?)\s+(?:kilo\s*)?(\d+(?:\.\d+)?)\s*(?:kwa|for)\s*(\d+(?:[,]\d+)*(?:\.\d+)?)/i.exec(text);
  if (purchaseSimple) {
    const item = normalizeItemName(purchaseSimple[1].trim());
    const quantity = Number(purchaseSimple[2]);
    const totalCost = Number(purchaseSimple[3].replace(/,/g, ""));
    return { intent: "record_purchase", item, quantity, unit: /rangi|paint|lita|litre/i.test(text) ? "L" : "kg", totalCost, supplier: null };
  }
  const purchaseKilo = /(?:nimenunua|namenunua|bought|purchased)\s+(.+?)\s+kilo\s+(\d+(?:\.\d+)?)\s+(?:kwa|for)\s+(\d+(?:[,]\d+)*(?:\.\d+)?)/i.exec(text);
  if (purchaseKilo) {
    return { intent: "record_purchase", item: normalizeItemName(purchaseKilo[1].trim()), quantity: Number(purchaseKilo[2]), unit: "kg", totalCost: Number(purchaseKilo[3].replace(/,/g, "")), supplier: null };
  }
  // ---- EXPENSE PATTERNS ----
  if (/(nimelipa|i paid|spent|lipa|kumba|dhamini).*(ksh|kes|pesa|shillings?)/i.test(text)) {
    const amountMatch = /(ksh|kes|pesa|shillings?)?\s*(\d+(?:,\d+)*)/i.exec(text);
    const amount = amountMatch ? Number(amountMatch[2].replace(/,/g, "")) : 0;
    const categories = {
      rent: "RENT", transportation: "TRANSPORT", transport: "TRANSPORT", fuel: "FUEL", electricity: "ELECTRICITY", water: "WATER",
      phone: "AIRTIME", airtime: "AIRTIME", wages: "WAGES", salary: "WAGES", repair: "REPAIR", maintenance: "MAINTENANCE"
    };
    let category = "OTHER";
    for (const [key, val] of Object.entries(categories)) {
      if (new RegExp(key, "i").test(text)) { category = val; break; }
    }
    const description = text.replace(/^\w+\s+/, "").slice(0, 100);
    return { intent: "record_expense", category, description, amount };
  }
  // ---- DEBT PATTERNS ----
  if (/(sold on credit|imenunuliwa kwa madeni|bought on credit|amiliki kwa madeni|akakufa|took goods)/i.test(lower)) {
    const amountMatch = /(ksh|kes|pesa|shillings?)?\s*(\d+(?:,\d+)*)/i.exec(text);
    const amount = amountMatch ? Number(amountMatch[2].replace(/,/g, "")) : 0;
    const customerMatch = /(?:to|kwa)\s+(.+?)(?:\s+for|\s+kwa|\s+ksh|\s+kes|$)/i.exec(text);
    const customerName = customerMatch?.[1]?.trim();
    const isSupplerDebt = /(bought|purchased|nimenunua).*(on credit|kwa credit|kwa madeni)/.test(lower);
    const isCustomerDebt = /(sold|nimeuza).*(on credit|kwa credit|kwa madeni)/.test(lower) || /(took goods|akakufa)/.test(lower);
    if (isCustomerDebt) return { intent: "customer_debt", customerName, amountOwed: amount };
    if (isSupplerDebt) return { intent: "supplier_debt", supplierName: customerName, amountOwed: amount };
    return { intent: "unknown", text };
  }
  if (/(nani ananidai|who owes me|nani ana madeni|who do i owe|madeni yangu)/i.test(lower)) {
    const isReceivables = /(nani ananidai|who owes me|nani ana madeni|customers)/.test(lower);
    const isPayables = /(who do i owe|nina madeni|suppliers|owe)/.test(lower);
    if (isReceivables) return { intent: "list_customer_debts" };
    if (isPayables) return { intent: "list_supplier_debts" };
    return { intent: "list_customer_debts" };
  }
  if (/(how much|kiasi gani).*(profit|faida|earnings|gains|kasoro)/i.test(lower) || /(my profit this week|profit this week|faida ya wiki hii)/i.test(lower)) {
    return { intent: "profit_report", period: "week" };
  }
  if (/(paid|kulipa|paid up|alipia).*(debt|madeni)/i.test(lower)) {
    const amountMatch = /(ksh|kes|pesa|shillings?)?\s*(\d+(?:,\d+)*)/i.exec(text);
    const amount = amountMatch ? Number(amountMatch[2].replace(/,/g, "")) : 0;
    const payerMatch = /(?:to|kwa)\s+(.+?)(?:\s+ksh|\s+kes|$)/i.exec(text);
    const payerName = payerMatch?.[1]?.trim();
    return { intent: "payment_recorded", amount, counterparty: payerName };
  }
  if (/(how much|ngapi).*(steel|chuma)/.test(lower) || /(steel|chuma).*(ngapi|how much)/.test(lower)) {
    return { intent: "inventory_query", item: "Steel" };
  }
  if (/(wiki hii|this week|biashara imefanyaje|business perform)/i.test(lower)) return { intent: "business_summary", period: "week" };
  if (/(bidhaa gani|best selling|inauza zaidi)/i.test(lower)) return { intent: "sales_summary", period: "week" };
  if (/(downtime sana|machine performance|imekuwa na downtime)/i.test(lower)) return { intent: "machine_performance", period: "week" };
  if (/(order|oda).*(iko wapi|status|where)/i.test(lower)) return { intent: "order_query", order: text };
  const workspace = /(?:create|configure|setup|set up)\s+(?:my\s+)?workspace.*?(?:company|business)\s*[:=-]?\s*([^,;]+).*?(?:city|town)\s*[:=-]?\s*([^,;]+).*?(?:owner|owner name)\s*[:=-]?\s*([^,;]+).*?(?:phone|phone number)\s*[:=-]?\s*(\+?[\d\s()-]{9,})/i.exec(text);
  if (workspace) return { intent: "setup_workspace", companyName: workspace[1].trim(), city: workspace[2].trim(), ownerName: workspace[3].trim(), ownerPhone: workspace[4].replace(/[\s()-]/g, "") };
  // ---- Module read intents ----
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(users?|team|watu|staff|workers?)/i.test(lower)) return { intent: "list_users" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(production|uzalishaji|entries|records?)/i.test(lower)) return { intent: "list_production_entries" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(products?|bidhaa|goods?|items?)/i.test(lower)) return { intent: "list_products" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(materials?|vifaa|raw)/i.test(lower)) return { intent: "list_materials" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look|show me).*(inventory|stock|stok|hesabu)/i.test(lower)) return { intent: "inventory_summary" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(orders?|maagizo|odas?)/i.test(lower)) return { intent: "list_orders" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(invoices?|bill|bili|malipo)/i.test(lower)) return { intent: "list_invoices" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(payments?|malipo|lipa|mpesa)/i.test(lower)) return { intent: "list_payments" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(machines?|mashine)/i.test(lower)) return { intent: "list_machines" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(downtime|arifacts?|breakdown)/i.test(lower)) return { intent: "list_downtime_events" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(maintenance|ukarabati)/i.test(lower)) return { intent: "list_maintenance_events" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(alerts?|arifa|warnings?|taarifa)/i.test(lower)) return { intent: "list_alerts" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(notifications?|messages?|tangazo)/i.test(lower)) return { intent: "list_notifications" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(customers?|wateja)/i.test(lower)) return { intent: "list_customers" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(suppliers?|wauzaji)/i.test(lower)) return { intent: "list_suppliers" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(expenses?|gharama)/i.test(lower)) return { intent: "list_expenses" };
  if (/^(list|show|display|ona|onesha|angalia|view|get|look).*(users?|team|watu)/.test(lower) && /(role|jukumu)/.test(lower)) return { intent: "list_users" };
  if (/(company|biashara|kampuni|about|kuhusu)/i.test(lower) && /(info|details|maarifa|profile|overview)/i.test(lower)) return { intent: "company_info" };
  // ---- Module write intents ----
  if (/(add|create|register|sajili|weka).*(user|team member|staff|worker|mtu)/i.test(lower)) {
    const name = /(?:named?|called?|jina)\s+(.+?)(?:\s*,|\s+phone|\s+role|\s+as|$)/i.exec(text)?.[1]?.trim() || /(?:add|create|register|sajili|weka)\s+(?:a\s+)?(?:user|team member|staff|worker|mtu)\s+(?:named?|called?|jina)?\s*(.+?)(?:\s*,|\s+phone|\s+role|\s+as|$)/i.exec(text)?.[1]?.trim();
    const phone = /(?:phone|simu|number|nambari)\s*[:=]?\s*(\+?[\d\s()-]{9,})/i.exec(text)?.[1]?.replace(/[\s()-]/g, "") || /\+?254\d{9}/.exec(text)?.[0];
    const role = /(?:as|role|jukumu|position)\s*(OWNER|MANAGER|SUPERVISOR|STOREKEEPER|OPERATOR|TECHNICIAN|ACCOUNTANT)/i.exec(text)?.[1]?.toUpperCase();
    return { intent: "add_user", name, phone, role };
  }
  if (/(add|create|register|sajili).*(supplier|wauzaji)/i.test(lower)) {
    const name = /(?:named?|called?|jina)\s+(.+?)(?:\s*,|\s+phone|$)/i.exec(text)?.[1]?.trim() || /(?:add|create|register|sajili)\s+(?:a\s+)?(?:supplier|wauzaji)\s+(?:named?|called?|jina)?\s*(.+?)(?:\s*,|\s+phone|$)/i.exec(text)?.[1]?.trim();
    const phone = /(?:phone|simu|number)\s*[:=]?\s*(\+?[\d\s()-]{9,})/i.exec(text)?.[1]?.replace(/[\s()-]/g, "") || /\+?254\d{9}/.exec(text)?.[0];
    return { intent: "add_supplier", name, phone };
  }
  if (/(update|change|badilisha|rekebisha).*(user|mtu).*(role|jukumu)/i.test(lower) || /(?:assign|weka).*(role|jukumu).*\s+to\s+/i.test(lower)) {
    const name = /(?:user|mtu)\s+(.+?)(?:\s+to|\s+as|\s+role|$)/i.exec(text)?.[1]?.trim() || /(?:update|change|badilisha|rekebisha)\s+(.+?)\s+(?:to|role)/i.exec(text)?.[1]?.trim();
    const role = /(?:role|jukumu|as)\s*(OWNER|MANAGER|SUPERVISOR|STOREKEEPER|OPERATOR|TECHNICIAN|ACCOUNTANT)/i.exec(text)?.[1]?.toUpperCase();
    return { intent: "update_user_role", name, role };
  }
  if (/(delete|remove|futa|ondoa).*(user|mtu|staff|worker)/i.test(lower)) {
    const name = /(?:delete|remove|futa|ondoa)\s+(?:user|mtu|staff|worker)?\s*(.+?)(?:\s*$)/i.exec(text)?.[1]?.trim();
    return { intent: "delete_user", name };
  }
  if (/(update|change|badilisha|rekebisha|set).*(machine|mashine).*(status|hali)/i.test(lower)) {
    const machine = /(?:machine|mashine)\s*(\d+)/i.exec(text)?.[1] || /(?:machine|mashine)\s+(\w+)/i.exec(text)?.[1];
    const status = /(running|idle|down|maintenance|kazi|stahili|haribika|ukarabati)/i.exec(lower)?.[1]?.toUpperCase();
    const statusMap = { RUNNING: 'RUNNING', IDLE: 'IDLE', DOWN: 'DOWN', MAINTENANCE: 'MAINTENANCE', KAZI: 'RUNNING', STAHILI: 'IDLE', HARIBIKA: 'DOWN', UKARABATI: 'MAINTENANCE' };
    return { intent: "update_machine_status", machine: machine ? `Machine ${machine}` : null, status: statusMap[status] || status };
  }
  if (/(update|change|badilisha|rekebisha|set).*(order|oda).*(status|hali)/i.test(lower)) {
    const order = /(?:order|oda)\s*([A-Za-z0-9-]+)/i.exec(text)?.[1];
    const status = /(in.production|ready|shipped|delivered|completed|cancelled|imekamilika|imepelekwa)/i.exec(lower)?.[1]?.toUpperCase()?.replace(/\s+/g, '_');
    return { intent: "update_order_status", order, status };
  }
  if (/(acknowledge|thibitisha|confirm).*(alert|arifa|warning)/i.test(lower)) {
    const alert = /(?:alert|arifa|warning)\s*([a-z0-9_-]+)/i.exec(text)?.[1];
    return { intent: "acknowledge_alert", alert };
  }
  if (/(assign|weka|kabidhi).*(alert|arifa|warning).*\s+to\s+/i.test(lower)) {
    const alert = /(?:alert|arifa|warning)\s*([a-z0-9_-]+)/i.exec(text)?.[1];
    const user = /(?:to|kwa)\s+(.+?)$/i.exec(text)?.[1]?.trim();
    return { intent: "assign_alert", alert, name: user };
  }
  if (/(resolve|tatua|maliza|fix).*(alert|arifa|warning)/i.test(lower)) {
    const alert = /(?:alert|arifa|warning)\s*([a-z0-9_-]+)/i.exec(text)?.[1];
    return { intent: "resolve_alert", alert };
  }
  if (/(create|generate|fungua|tengeneza).*(invoice|bili|bill)/i.test(lower)) {
    const order = /(?:order|oda)\s*([A-Za-z0-9-]+)/i.exec(text)?.[1];
    const amount = /(?:amount|pesa|ksh|kes)\s*(\d+)/i.exec(text)?.[1];
    return { intent: "create_invoice", order, amount: amount ? Number(amount) : undefined };
  }
  if (/(update|change|badilisha).*(invoice|bili).*(status|hali)/i.test(lower)) {
    const invoice = /(?:invoice|bili|bill)\s*([A-Za-z0-9-]+)/i.exec(text)?.[1];
    const status = /(paid|unpaid|cancelled|imeanalipiwa|haitajalipiwa)/i.exec(lower)?.[1]?.toUpperCase();
    return { intent: "update_invoice_status", invoice, status };
  }
  if (/(add|create|register|sajili).*(customer|wateja|client)/i.test(lower)) {
    const name = /(?:named?|called?|jina)\s+(.+?)(?:\s*,|\s+phone|$)/i.exec(text)?.[1]?.trim() || /(?:add|create|register|sajili)\s+(?:a\s+)?(?:customer|wateja|client)\s+(?:named?|called?|jina)?\s*(.+?)(?:\s*,|\s+phone|$)/i.exec(text)?.[1]?.trim();
    const phone = /(?:phone|simu|number)\s*[:=]?\s*(\+?[\d\s()-]{9,})/i.exec(text)?.[1]?.replace(/[\s()-]/g, "") || /\+?254\d{9}/.exec(text)?.[0];
    return { intent: "add_customer", name, phone };
  }
  if (/(update|change|badilisha).*(customer|wateja)/i.test(lower)) {
    const name = /(?:customer|wateja)\s+(.+?)(?:\s+to|\s+phone|\s+name|$)/i.exec(text)?.[1]?.trim();
    const newName = /(?:to|name|jina)\s+(.+?)(?:\s*,|\s+phone|$)/i.exec(text)?.[1]?.trim();
    const phone = /(?:phone|simu|number)\s*[:=]?\s*(\+?[\d\s()-]{9,})/i.exec(text)?.[1]?.replace(/[\s()-]/g, "") || /\+?254\d{9}/.exec(text)?.[0];
    return { intent: "update_customer", name, newName, phone };
  }
  if (/(delete|remove|futa|ondoa).*(customer|wateja|client)/i.test(lower)) {
    const name = /(?:delete|remove|futa|ondoa)\s+(?:customer|wateja|client)?\s*(.+?)(?:\s*$)/i.exec(text)?.[1]?.trim();
    return { intent: "delete_customer", name };
  }
  return { intent: "unknown", text };
}

function openRouterConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function nvidiaConfigured() {
  return Boolean(process.env.NVIDIA_API_KEY || (process.env.AI_PROVIDER === "nvidia" && process.env.AI_API_KEY));
}

function activeAiProvider() {
  const requested = String(process.env.AI_PROVIDER || "").toLowerCase();
  if (requested === "openrouter" && openRouterConfigured()) return "openrouter";
  if (requested === "nvidia" && nvidiaConfigured()) return "nvidia";
  if (nvidiaConfigured()) return "nvidia";
  if (openRouterConfigured()) return "openrouter";
  return "local";
}

// Free models tried in order when the configured one fails (both support tool calls).
const OPENROUTER_FREE_FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free"
];

function openRouterModels() {
  const configured = process.env.OPENROUTER_MODEL || "openrouter/auto";
  const models = [configured, ...OPENROUTER_FREE_FALLBACK_MODELS];
  return [...new Set(models.filter(Boolean))];
}

function nvidiaModel() {
  return process.env.NVIDIA_MODEL || process.env.AI_MODEL || "meta/llama-3.3-70b-instruct";
}

function aiBusinessContext() {
  const summary = getBusinessSummary();
  const stock = all("SELECT item_name, quantity, unit, reorder_level FROM inventory WHERE item_type='RAW_MATERIAL' ORDER BY item_name");
  const machines = all("SELECT machine_no, name, status FROM machines ORDER BY machine_no");
  const recentSales = all("SELECT item_name, quantity, unit, amount, created_at FROM sales_transactions ORDER BY created_at DESC LIMIT 20");
  return {
    company: get("SELECT name, city FROM companies LIMIT 1"), summary, stock, machines, recentSales
  };
}

function languageInstruction(language) {
  return String(language).toLowerCase() === "swahili"
    ? "Reply only in Kiswahili. Do not add English translations unless the user asks."
    : "Reply only in clear English. Do not add Swahili translations unless the user asks.";
}

async function askOpenRouter(message, language = "English", jsonMode = false) {
  if (!openRouterConfigured()) return null;
  let lastError = null;
  for (const model of openRouterModels()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_BASE_URL || "http://localhost:3000",
          "X-Title": "Biashara OS"
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 350,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            {
              role: "system",
              content: `You are Biashara OS, a concise, helpful assistant for a Kenyan manufacturing SME. ${languageInstruction(language)} Use only the provided business context; say when data is unavailable. Natural-language actions may be recorded by the validated backend after you extract their details. Never claim an action was recorded unless the backend response confirms it. Keep responses under 120 words.`
            },
            { role: "system", content: `Business context: ${JSON.stringify(aiBusinessContext())}` },
            { role: "user", content: String(message).slice(0, 4_000) }
          ]
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error?.message || payload?.message || `OpenRouter request failed (${res.status})`);
      const content = payload?.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? content.map((part) => part?.text || "").join("") : content;
      if (!String(text || "").trim()) throw new Error(`${model} returned an empty response`);
      return { text: String(text).trim(), model: payload?.model || model };
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function askNvidia(message, language = "English", jsonMode = false) {
  if (!nvidiaConfigured()) return null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const model = nvidiaModel();
      const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY || process.env.AI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 350,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            {
              role: "system",
              content: `You are Biashara OS, a concise, helpful assistant for a Kenyan manufacturing SME. ${languageInstruction(language)} Use only the provided business context; say when data is unavailable. Natural-language actions may be recorded by the validated backend after you extract their details. Never claim an action was recorded unless the backend response confirms it. Keep responses under 120 words.`
            },
            { role: "system", content: `Business context: ${JSON.stringify(aiBusinessContext())}` },
            { role: "user", content: String(message).slice(0, 4_000) }
          ]
        })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error?.message || payload?.message || `NVIDIA NIM request failed (${res.status})`);
      const content = payload?.choices?.[0]?.message?.content;
      const text = Array.isArray(content) ? content.map((part) => part?.text || "").join("") : content;
      if (!String(text || "").trim()) throw new Error(`${model} returned an empty response`);
      return { text: String(text).trim(), model: payload?.model || model, provider: "nvidia" };
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function askAiProvider(message, language = "English", jsonMode = false) {
  const preferred = activeAiProvider();
  const providers = preferred === "nvidia" ? ["nvidia", "openrouter"] : preferred === "openrouter" ? ["openrouter", "nvidia"] : ["nvidia", "openrouter"];
  let lastError = null;
  for (const provider of providers) {
    try {
      if (provider === "nvidia" && nvidiaConfigured()) {
        const answer = await askNvidia(message, language, jsonMode);
        return answer ? { ...answer, provider: "nvidia" } : null;
      }
      if (provider === "openrouter" && openRouterConfigured()) {
        const answer = await askOpenRouter(message, language, jsonMode);
        if (answer) return { ...answer, provider: "openrouter" };
      }
    } catch (error) {
      lastError = error;
      console.error(`${provider} AI provider error:`, error.message);
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function askAlternateProvider(message, language = "English", jsonMode = false, excluded = "") {
  const providers = ["nvidia", "openrouter"].filter((provider) => provider !== excluded);
  for (const provider of providers) {
    try {
      if (provider === "nvidia" && nvidiaConfigured()) return await askNvidia(message, language, jsonMode);
      if (provider === "openrouter" && openRouterConfigured()) return await askOpenRouter(message, language, jsonMode);
    } catch (error) {
      console.error(`${provider} structured extraction error:`, error.message);
    }
  }
  return null;
}

const AGENT_TOOLS = [
  { type: "function", function: { name: "record_sale", description: "Record a completed sale of goods to a customer. Use ONLY when the user sold something. Swahili: nimeuza.", parameters: { type: "object", properties: { item: { type: "string" }, quantity: { type: "number" }, unit: { type: "string" }, amount: { type: "number" }, customer: { type: "string" }, payment_status: { type: "string", enum: ["PAID", "CREDIT"] } }, required: ["item", "quantity", "amount"] } } },
  { type: "function", function: { name: "record_purchase", description: "Record a purchase of materials or goods from a supplier. Use ONLY when the user bought something. Swahili: nimenunua.", parameters: { type: "object", properties: { item: { type: "string" }, quantity: { type: "number" }, unit: { type: "string" }, total_cost: { type: "number" }, supplier: { type: "string" }, payment_status: { type: "string", enum: ["PAID", "CREDIT"] } }, required: ["item", "quantity", "total_cost"] } } },
  { type: "function", function: { name: "record_production", description: "Record production: consume materials, produce finished goods. Swahili: tumetengeneza/nimetengeneza.", parameters: { type: "object", properties: { product: { type: "string" }, quantity_produced: { type: "number" }, material: { type: "string" }, quantity_consumed: { type: "number" }, unit: { type: "string" } }, required: ["product", "quantity_produced"] } } },
  { type: "function", function: { name: "record_expense", description: "Record a business expense (rent, electricity, transport, wages, etc).", parameters: { type: "object", properties: { category: { type: "string" }, description: { type: "string" }, amount: { type: "number" } }, required: ["category", "amount"] } } },
  { type: "function", function: { name: "record_customer_payment", description: "Record a payment received from a customer reducing their outstanding debt. Use when a customer pays or has paid. Swahili: alinilipa/alinipa. E.g. 'John paid me 10,000' or 'John alinilipa 20,000'.", parameters: { type: "object", properties: { customer: { type: "string", description: "Customer name" }, amount: { type: "number", description: "Amount paid" }, method: { type: "string", enum: ["CASH", "MPESA", "BANK"], description: "Payment method" } }, required: ["customer", "amount"] } } },
  { type: "function", function: { name: "record_supplier_payment", description: "Record a payment made to a supplier reducing your outstanding payable. Use when you pay a supplier. Swahili: nimelipa/nilimlipa. E.g. 'Nimelipa Kamau 20,000'.", parameters: { type: "object", properties: { supplier: { type: "string", description: "Supplier name" }, amount: { type: "number", description: "Amount paid" }, method: { type: "string", enum: ["CASH", "MPESA", "BANK"] } }, required: ["supplier", "amount"] } } },
  { type: "function", function: { name: "configure_material", description: "Register a new raw material and its opening inventory.", parameters: { type: "object", properties: { material: { type: "string" }, initial_stock: { type: "number" }, unit: { type: "string" }, minimum_threshold: { type: "number" }, supplier: { type: "string" } }, required: ["material", "initial_stock", "unit"] } } },
  { type: "function", function: { name: "get_inventory_level", description: "Look up current stock for a material or product.", parameters: { type: "object", properties: { material: { type: "string" } }, required: ["material"] } } },
  { type: "function", function: { name: "get_business_summary", description: "Return the real weekly business summary: revenue, expenses, profit, production.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_profit_loss", description: "Return profit and loss for a given period. Use for questions about profit, revenue, expenses. Swahili: faida.", parameters: { type: "object", properties: { period: { type: "string", enum: ["today", "week", "month"] } }, required: ["period"] } } },
  { type: "function", function: { name: "get_customer_debts", description: "Return all outstanding customer receivables — money owed to the business. Swahili: nani ananidai.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "get_supplier_debts", description: "Return all outstanding supplier payables — money the business owes. Swahili: nina madeni kiasi gani.", parameters: { type: "object", properties: {}, required: [] } } },
  // ── Jua Kali extension tools ────────────────────────────────────────────
  { type: "function", function: { name: "suggest_price", description: "Suggest a sale price for a product using past sales + optional material cost + time estimate. Swahili: bei gani / nipange bei. Use when the fundi asks what to charge.", parameters: { type: "object", properties: { product: { type: "string", description: "Product or job name (e.g. 'steel gate', 'mlango wa chuma')" }, material_cost: { type: "number", description: "Optional: total material cost in KSh for this unit" }, time_hours: { type: "number", description: "Optional: labour hours expected" }, hourly_rate: { type: "number", description: "Optional: KSh per hour (default 500)" }, markup_pct: { type: "number", description: "Optional: markup percent (default 35)" } }, required: ["product"] } } },
  { type: "function", function: { name: "get_daily_cashbook", description: "Return the day's money-in / money-out summary (hesabu ya siku). Omit date for today, or pass YYYY-MM-DD.", parameters: { type: "object", properties: { date: { type: "string", description: "Optional YYYY-MM-DD; defaults to today" } }, required: [] } } },
  { type: "function", function: { name: "add_chama_member", description: "Register a new member in the chama (group savings). Swahili: ongeza mwanachama.", parameters: { type: "object", properties: { name: { type: "string" }, phone: { type: "string" }, role: { type: "string", enum: ["MEMBER","MWENYEKITI","KATIBU","MWEKA_HAZINA"], description: "Default MEMBER" } }, required: ["name"] } } },
  { type: "function", function: { name: "log_chama_contribution", description: "Log a chama deposit, withdrawal, loan, or repayment. Swahili: nimechanga / nimekopa / nimerudisha.", parameters: { type: "object", properties: { member: { type: "string", description: "Member name" }, amount: { type: "number" }, kind: { type: "string", enum: ["DEPOSIT","WITHDRAW","LOAN","REPAY"], description: "DEPOSIT (nimechanga), WITHDRAW, LOAN (nimekopa), REPAY (nimerudisha)" }, note: { type: "string" } }, required: ["member", "amount", "kind"] } } },
  { type: "function", function: { name: "get_chama_balance", description: "Chama balance. Omit member to get the whole pool, pass a member name for their individual balance.", parameters: { type: "object", properties: { member: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "list_chama_members", description: "List all chama members with their current individual balances and the pool total.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "record_piecework", description: "Log a piecework job done by a worker (units × rate = amount). Settled weekly. Swahili: kazi ya X vipande.", parameters: { type: "object", properties: { worker: { type: "string" }, job: { type: "string", description: "Short job label e.g. 'weld hinges' / 'mlango'" }, units: { type: "number", description: "Number of units done" }, rate: { type: "number", description: "KSh per unit" } }, required: ["worker", "job", "units", "rate"] } } },
  { type: "function", function: { name: "get_pending_piecework", description: "Return unpaid piecework totals. Pass a worker name to filter, omit for everyone.", parameters: { type: "object", properties: { worker: { type: "string" } }, required: [] } } }
];

async function callToolModel(provider, messages, timeoutMs = 20_000) {
  const isNvidia = provider === "nvidia";
  const endpoint = isNvidia ? "https://integrate.api.nvidia.com/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const models = isNvidia ? [nvidiaModel()] : openRouterModels();
  const headers = { Authorization: `Bearer ${isNvidia ? process.env.NVIDIA_API_KEY || process.env.AI_API_KEY : process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" };
  let lastError = null;
  // Free models are often rate-limited upstream, so fall through to the next one.
  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, { method: "POST", signal: controller.signal, headers, body: JSON.stringify({ model, temperature: 0.1, max_tokens: 1200, messages, tools: AGENT_TOOLS, tool_choice: "auto" }) });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error?.message || `AI tool request failed (${res.status})`);
      return { message: payload.choices?.[0]?.message, model: payload.model || model, provider };
    } catch (err) {
      lastError = err;
      console.error(`${model} tool request failed:`, err.message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// Each signed-in account gets AI_DAILY_LIMIT AI requests per Kenyan calendar day
// (EAT, UTC+3). The count lives in the account's own database so it survives restarts.
const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 5;
const AI_LIMIT_MESSAGE = `You have used all ${AI_DAILY_LIMIT} AI requests for today. Please wait until tomorrow to use the AI assistant again.`;
const kenyaDay = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

function takeAiAllowance() {
  const day = kenyaDay();
  const used = get("SELECT count FROM ai_usage WHERE day = :day", { day })?.count || 0;
  if (used >= AI_DAILY_LIMIT) return false;
  run("INSERT INTO ai_usage (day, count) VALUES (:day, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1", { day });
  return true;
}

// Build a rich, Jua Kali-aware system prompt that primes the model with today's
// date, currency, business identity, known names (so it uses existing records
// instead of inventing new spellings), and Swahili verb conventions.
function buildAgentSystemPrompt(language) {
  const company = get("SELECT name, city FROM companies LIMIT 1") || {};
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const dowSw = ["Jumapili","Jumatatu","Jumanne","Jumatano","Alhamisi","Ijumaa","Jumamosi"][today.getDay()];
  const safe = (rows, key) => rows.map(r => r[key]).filter(Boolean).join(", ") || "(none yet)";
  const customers = safe(all("SELECT name FROM customers ORDER BY created_at DESC LIMIT 20"), "name");
  const suppliers = safe(all("SELECT name FROM suppliers ORDER BY created_at DESC LIMIT 20"), "name");
  const materials = safe(all("SELECT item_name FROM inventory WHERE item_type='RAW_MATERIAL' ORDER BY item_name LIMIT 30"), "item_name");
  const products  = safe(all("SELECT name FROM products ORDER BY created_at DESC LIMIT 20"), "name");
  return `You are Biashara GPT — the voice inside a Kenyan Jua Kali / SME business OS called ${company.name || "Biashara OS"}${company.city ? " in " + company.city : ""}.
Today is ${dateStr} (${dowSw}). Currency: Kenyan Shilling (KSh / Ksh / shillings / bob).
Reply in ${language}. If the user wrote in Kiswahili, Sheng, or mixed English/Swahili, mirror their language and keep it short and friendly — this is a fundi on a feature phone, not a corporate client.

HARD RULES:
- Use tools for every data read or write. Never claim an action happened without a successful tool result.
- You may chain multiple tool calls across turns (e.g. check stock first, then record the sale).
- Quantities and amounts must be positive numbers. If a user is ambiguous, ask ONE short clarifying question.
- Keep answers under 400 chars unless listing many rows. No markdown headers in SMS/USSD contexts.
- Prefer existing records: if a name the user mentions is close to one of the KNOWN RECORDS below, use that exact spelling.

SWAHILI VERB CHEAT SHEET:
- nimeuza = I sold → record_sale
- nimenunua = I bought → record_purchase
- nimelipa = I paid → record_expense (if bills/rent) or record_supplier_payment (if to a supplier)
- alinilipa / amenilipa / amelipia = customer paid me → record_customer_payment
- nimetengeneza / tumetengeneza = I/we produced → record_production
- nina deni ya X = I owe X → get_supplier_debts
- ananidai / anandai / mimi ni mdeni = I'm owed by them → get_customer_debts
- bei gani? / nipange bei = pricing question → suggest_price

KNOWN RECORDS (use these spellings; do not invent new names if a close match exists):
- Customers: ${customers}
- Suppliers: ${suppliers}
- Materials: ${materials}
- Products:  ${products}`;
}

// Validation helpers used by every tool handler. Throwing means we return
// {error:...} to the model and let it correct itself in the next round.
function _requirePositive(val, label) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number`);
  return n;
}
function _requireString(val, label) {
  const s = String(val || "").trim();
  if (!s) throw new Error(`${label} is required`);
  return s;
}

// Dispatch a single tool call. Returns the backend result or {error:string}.
async function runToolCall(call, ctx) {
  const { message, channel, userId } = ctx;
  let input;
  try { input = JSON.parse(call.function.arguments || "{}"); } catch { return { error: "Invalid JSON in tool arguments" }; }
  const name = call.function.name;
  try {
    if (name === "record_sale") {
      const item = _requireString(input.item, "item");
      const quantity = _requirePositive(input.quantity, "quantity");
      const amount = _requirePositive(input.amount, "amount");
      return withTransaction(() => createSale({ itemName: item, quantity, unit: input.unit || "units", amount, customer: input.customer, paymentStatus: input.payment_status || "PAID", source: channel, userId, originalMessage: message, structured: { intent: "sale", ...input } }));
    }
    if (name === "record_purchase") {
      const item = _requireString(input.item, "item");
      const quantity = _requirePositive(input.quantity, "quantity");
      const totalCost = _requirePositive(input.total_cost, "total_cost");
      return withTransaction(() => recordPurchase({ supplierName: input.supplier, itemName: item, quantity, unit: input.unit || "kg", totalCost, paymentStatus: input.payment_status || "PAID", source: channel, userId, originalMessage: message }));
    }
    if (name === "record_production") {
      const product = _requireString(input.product, "product");
      const quantityProduced = _requirePositive(input.quantity_produced, "quantity_produced");
      return withTransaction(() => createProductionEntry({ productName: product, quantityProduced, materialName: input.material, quantityConsumed: Number(input.quantity_consumed) || 0, unit: input.unit || "kg", source: channel, userId, originalMessage: message, structured: { intent: "production_update", ...input } }));
    }
    if (name === "record_expense") {
      const amount = _requirePositive(input.amount, "amount");
      return withTransaction(() => recordExpense({ category: String(input.category || "OTHER").toUpperCase(), description: input.description, amount, userId, source: channel }));
    }
    if (name === "record_customer_payment") {
      const customer = _requireString(input.customer, "customer");
      const amount = _requirePositive(input.amount, "amount");
      const cust = findCustomer(customer);
      if (!cust) return { error: `Customer "${customer}" not found.` };
      const debt = get("SELECT * FROM customer_debts WHERE customer_id=:cid AND status IN ('UNPAID','PARTIAL') ORDER BY created_at DESC LIMIT 1", { cid: cust.id });
      if (!debt) return { error: `No outstanding debt for ${cust.name}.` };
      const r = withTransaction(() => recordDebtPayment({ debtId: debt.id, amount, paymentMethod: input.method || "CASH", userId, source: channel }));
      r.customerName = cust.name; return r;
    }
    if (name === "record_supplier_payment") {
      const supplier = _requireString(input.supplier, "supplier");
      const amount = _requirePositive(input.amount, "amount");
      const sup = findSupplier(supplier);
      if (!sup) return { error: `Supplier "${supplier}" not found.` };
      const debt = get("SELECT * FROM supplier_debts WHERE supplier_id=:sid AND status IN ('UNPAID','PARTIAL') ORDER BY created_at DESC LIMIT 1", { sid: sup.id });
      if (!debt) return { error: `No outstanding payable to ${sup.name}.` };
      const r = withTransaction(() => recordSupplierPayment({ debtId: debt.id, amount, paymentMethod: input.method || "CASH", userId, source: channel }));
      r.supplierName = sup.name; return r;
    }
    if (name === "configure_material") {
      const material = _requireString(input.material, "material");
      return withTransaction(() => configureRecord({ target: "material", name: material, quantity: Number(input.initial_stock) || 0, unit: input.unit || "kg", reorderLevel: Number(input.minimum_threshold) || 0, supplier: input.supplier, source: channel, userId, originalMessage: message, structured: { intent: "configure", target: "material", ...input } }));
    }
    if (name === "get_inventory_level") return findInventoryItem(input.material) || { error: `${input.material} is not configured in inventory.` };
    if (name === "get_business_summary") return getBusinessSummary();
    if (name === "get_profit_loss") return getProfitAndLoss(input.period || "week");
    if (name === "get_customer_debts") return getCustomerDebts();
    if (name === "get_supplier_debts") return getSupplierPayables();
    // Jua Kali extension tools
    if (name === "suggest_price") return suggestPrice(input);
    if (name === "get_daily_cashbook") return getDailyCashbook(input.date);
    if (name === "add_chama_member") return withTransaction(() => addChamaMember({ ...input, source: channel, userId }));
    if (name === "log_chama_contribution") return withTransaction(() => logChamaContribution({ ...input, source: channel, userId }));
    if (name === "get_chama_balance") return getChamaBalance(input.member);
    if (name === "list_chama_members") return listChamaMembers();
    if (name === "record_piecework") return withTransaction(() => recordPiecework({ ...input, source: channel, userId }));
    if (name === "get_pending_piecework") return getPendingPiecework(input.worker);
    return { error: "Unknown tool: " + name };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

async function runToolAgent(message, language, userId, channel, aiTimeoutMs = 20_000) {
  const providers = activeAiProvider() === "nvidia" ? ["nvidia", "openrouter"] : ["openrouter", "nvidia"];
  const system = buildAgentSystemPrompt(language);
  for (const provider of providers) {
    if (provider === "nvidia" && !nvidiaConfigured()) continue;
    if (provider === "openrouter" && !openRouterConfigured()) continue;
    try {
      const messages = [{ role: "system", content: system }, { role: "user", content: String(message || "").slice(0, 4000) }];
      const applied = [];
      let answer = await callToolModel(provider, messages, aiTimeoutMs);
      // Multi-round tool loop: let the model chain lookups and writes until it
      // produces a final text answer or we hit the safety cap.
      for (let round = 0; round < 5; round++) {
        const toolCalls = answer.message?.tool_calls || [];
        if (!toolCalls.length) break;
        messages.push(answer.message);
        for (const call of toolCalls) {
          const result = await runToolCall(call, { message, channel, userId });
          applied.push({ name: call.function.name, result });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
        }
        answer = await callToolModel(provider, messages, aiTimeoutMs);
      }
      const text = answer.message?.content || (applied.length ? applied.map(a => a.result?.error ? `${a.name}: ${a.result.error}` : `✓ ${a.name}`).join("; ") : "");
      // If the provider produced nothing AND no tool was called, try the next one.
      if (!text && !applied.length) continue;
      return {
        response: String(text || "(no response)"),
        structured: applied.length ? { intent: applied[0].name, tool: applied[0].name, chain: applied.map(a => a.name) } : { intent: "answer" },
        result: applied.length ? applied[applied.length - 1].result : null,
        allApplied: applied,
        model: answer.model,
        provider: answer.provider,
        toolApplied: applied.length > 0
      };
    } catch (error) {
      console.error(`${provider} tool agent error:`, error.message);
    }
  }
  return null;
}

// Receipt / handwritten-note OCR. Accepts {image_base64, mime, note?} or
// {image_url, note?}. Uses an OpenRouter vision model to extract vendor,
// items, totals, and a category guess. Returns a *draft* expense the caller
// confirms via POST /api/expenses. We never auto-write from OCR — the fundi
// confirms first.
async function extractReceiptFromImage({ image_base64, image_url, mime = "image/jpeg", note = "" } = {}) {
  if (!openRouterConfigured()) {
    return { error: "Receipt OCR requires OPENROUTER_API_KEY. Set it in .env." };
  }
  if (!image_base64 && !image_url) {
    return { error: "Provide image_base64 (string) or image_url (URL)." };
  }
  const url = image_base64 ? `data:${mime};base64,${image_base64.replace(/^data:[^,]+,/, "")}` : image_url;
  // Use a vision-capable model. Fallback chain keeps us working if one goes
  // down. openRouterModels() returns the configured list; filter to known
  // vision names, otherwise pick a sane default.
  const visionModels = [
    "meta-llama/llama-3.2-11b-vision-instruct:free",
    "qwen/qwen-2-vl-7b-instruct:free",
    "google/gemini-flash-1.5-8b"
  ];
  const prompt = `You are a receipt reader for a Kenyan Jua Kali / SME expense system. Look at the image and extract the fields as STRICT JSON. No markdown, no prose, just one JSON object:
{
  "vendor": "<shop or supplier name on the receipt, or empty>",
  "date_hint": "<date as YYYY-MM-DD if visible, else empty>",
  "currency": "<KSh or detected currency symbol>",
  "items": [ { "name": "<item>", "quantity": <number>, "unit_price": <number>, "line_total": <number> } ],
  "total_amount": <number: grand total in KSh>,
  "category_guess": "<one of: MATERIALS, UTILITIES, TRANSPORT, WAGES, RENT, SUPPLIES, FOOD, OTHER>",
  "confidence": "<low|medium|high>",
  "note": "<brief interpretation; empty if nothing to add>"
}
If the image is unreadable, return {"error":"unreadable", "note":"..."}.
Numbers must be plain numbers (no commas or units). ${note ? "User note: " + note : ""}`;

  for (const model of visionModels) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 900,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You are a precise receipt-reading OCR engine. Reply only with the JSON object requested." },
            { role: "user", content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url } }
            ] }
          ]
        })
      });
      clearTimeout(timer);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { console.error("Receipt OCR provider error:", model, payload?.error); continue; }
      const raw = payload.choices?.[0]?.message?.content || "";
      // Model may wrap JSON in prose despite instructions; extract the first {...}.
      const match = String(raw).match(/\{[\s\S]*\}/);
      if (!match) continue;
      let parsed;
      try { parsed = JSON.parse(match[0]); } catch { continue; }
      if (parsed.error) return { error: parsed.error, note: parsed.note || "", model, provider: "openrouter" };
      // Normalise and return a draft that pairs with POST /api/expenses.
      const total = Number(parsed.total_amount) || (Array.isArray(parsed.items) ? parsed.items.reduce((s, i) => s + (Number(i.line_total) || Number(i.quantity || 0) * Number(i.unit_price || 0)), 0) : 0);
      const draft_expense = {
        category: String(parsed.category_guess || "OTHER").toUpperCase(),
        description: [parsed.vendor, Array.isArray(parsed.items) ? parsed.items.map(i => i.name).filter(Boolean).join(", ") : null].filter(Boolean).join(" — "),
        amount: Math.round(total * 100) / 100
      };
      return {
        provider: "openrouter",
        model,
        extracted: parsed,
        draft_expense,
        next_step: "POST /api/expenses with draft_expense (edit first if anything is wrong)."
      };
    } catch (err) {
      console.error("Receipt OCR attempt failed:", model, err.message);
    }
  }
  return { error: "All vision models failed. Try again, or lower the image resolution." };
}

// The model interprets natural language, but it never writes to the database.
// Only this validated result is passed to the business functions below.
async function extractStructuredAction(message, pending = null) {
  if (activeAiProvider() === "local") return null;
  const pendingContext = pending ? `Previous understood action: ${JSON.stringify(pending)}\n` : "";
  const prompt = `You are the action interpreter for a Kenyan business OS. Return ONLY one valid JSON object, no markdown, no prose. CRITICAL: nimenunua/bought/purchased = record_purchase. nimeuza/sold = sale. nimetengeneza/produced = production_update. nimelipa rent/electricity = record_expense. Schema intent values: "setup_workspace|sale|record_purchase|production_update|record_expense|configure|inventory_query|business_summary|profit_report|sales_summary|machine_performance|order_query|machine_downtime|sale_missing_details|list_users|list_products|list_materials|inventory_summary|list_orders|list_invoices|list_payments|list_machines|list_production_entries|list_downtime_events|list_maintenance_events|list_alerts|list_notifications|list_customers|list_suppliers|list_expenses|list_customer_debts|list_supplier_debts|company_info|add_user|update_user_role|delete_user|update_machine_status|update_order_status|acknowledge_alert|assign_alert|resolve_alert|create_invoice|update_invoice_status|add_customer|update_customer|delete_customer|add_supplier|customer_debt|supplier_debt". For record_purchase: fields item,quantity,unit,totalCost,supplier,paymentStatus. For sale: fields item,quantity,unit,amount,customer,paymentStatus. For record_expense: fields category,description,amount. Schema: {"intent":"...","companyName":"","city":"","ownerName":"","ownerPhone":"","target":"material|product|machine|customer|production_job","name":"","newName":"","unit":"kg|L|pcs|units","quantity":0,"reorder_level":0,"supplier":"","sku":"","price":0,"machine_no":"","location":"","phone":"","target_qty":0,"item":"","amount":0,"product":"","material":"","quantity_produced":0,"quantity_consumed":0,"period":"week","order":"","machine":"","alert":"","invoice":"","status":"","role":"OWNER|MANAGER|SUPERVISOR|STOREKEEPER|OPERATOR|TECHNICIAN|ACCOUNTANT"}. Interpret all natural language, including English, Kiswahili, and manufacturing terminology. Use sale_missing_details when a sale has an item and quantity but no amount. Use setup_workspace only when company, city, owner name, and phone are supplied. Use configure for adding materials, products, machines, customers, or production jobs. Use list_* intents when the user wants to see data from any module. Use company_info ONLY when the user explicitly asks about their company details (name, city, team, products count, materials count). For general business advice, strategy questions, or open-ended questions, return unknown. Use add_user/update_user_role/delete_user for user management. Use update_machine_status to change machine state. Use update_order_status to change order status. Use acknowledge_alert/assign_alert/resolve_alert for alert management. Use create_invoice/update_invoice_status for invoicing. Use add_customer/update_customer/delete_customer for customer management. Use the query intents for questions. Do not invent missing values. Combine the previous understood action with the new message when provided. ${pendingContext}User message: ${String(message || "").slice(0, 2000)}`;
  try {
    let answer = await askAiProvider(prompt, "English", true);
    let match = String(answer?.text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      const firstProvider = answer?.provider || activeAiProvider();
      answer = await askAlternateProvider(prompt, "English", true, firstProvider);
      match = String(answer?.text || "").match(/\{[\s\S]*\}/);
    }
    if (!match) return null;
    const value = JSON.parse(match[0]);
    if (value.intent === "sale" && String(value.item || "").trim() && Number(value.quantity) > 0 && Number(value.amount) > 0) {
      return { intent: "sale", item: String(value.item).trim(), quantity: Number(value.quantity), unit: String(value.unit || "kg"), amount: Number(value.amount), model: answer.model };
    }
    if (value.intent === "production_update" && String(value.product || "").trim() && String(value.material || "").trim() && Number(value.quantity_produced) > 0 && Number(value.quantity_consumed) > 0) {
      return { intent: "production_update", product: String(value.product).trim(), material: String(value.material).trim(), quantity_produced: Number(value.quantity_produced), quantity_consumed: Number(value.quantity_consumed), unit: String(value.unit || "kg"), model: answer.model };
    }
    if (value.intent === "configure" && String(value.target || "").trim() && String(value.name || "").trim()) {
      return { intent: "configure", target: String(value.target).trim(), name: String(value.name).trim(), unit: String(value.unit || "kg"), quantity: Number(value.quantity || 0), reorderLevel: Number(value.reorder_level || 0), supplier: String(value.supplier || ""), sku: String(value.sku || ""), price: Number(value.price || 0), machineNo: String(value.machine_no || ""), location: String(value.location || ""), phone: String(value.phone || ""), targetQty: Number(value.target_qty || 0), model: answer.model };
    }
    if (value.intent === "setup_workspace" && String(value.companyName || "").trim() && String(value.city || "").trim() && String(value.ownerName || "").trim() && String(value.ownerPhone || "").trim()) {
      return { intent: "setup_workspace", companyName: String(value.companyName).trim(), city: String(value.city).trim(), ownerName: String(value.ownerName).trim(), ownerPhone: String(value.ownerPhone).trim(), productName: String(value.productName || ""), productSku: String(value.productSku || ""), productUnit: String(value.productUnit || "units"), productPrice: Number(value.productPrice || 0), materialName: String(value.materialName || ""), materialUnit: String(value.materialUnit || "kg"), materialQuantity: Number(value.materialQuantity || 0), reorderLevel: Number(value.reorder_level || 0), model: answer.model };
    }
    if (value.intent === "sale_missing_details" && !pending && /\d/.test(String(message || ""))) {
      const correctionPrompt = `${prompt}\nIMPORTANT CORRECTION: Re-read the exact user message. The phrase "for KSh", "for KES", "for Kenyan shillings", or "for" followed by a number is the sale amount. If that phrase appears, intent MUST be sale and amount MUST be the number after it. Do not return sale_missing_details for a message that includes a sale amount.`;
      const correction = await askAlternateProvider(correctionPrompt, "English", true, answer?.provider || "");
      const correctionMatch = String(correction?.text || "").match(/\{[\s\S]*\}/);
      if (correctionMatch) {
        const corrected = JSON.parse(correctionMatch[0]);
        if (corrected.intent === "sale" && String(corrected.item || "").trim() && Number(corrected.quantity) > 0 && Number(corrected.amount) > 0) {
          return { intent: "sale", item: String(corrected.item).trim(), quantity: Number(corrected.quantity), unit: String(corrected.unit || "kg"), amount: Number(corrected.amount), model: correction.model };
        }
      }
    }
    // Pass-through read-only + simple action intents
    if (["inventory_query", "business_summary", "sales_summary", "machine_performance", "order_query", "machine_downtime", "sale_missing_details",
      "list_users", "list_products", "list_materials", "inventory_summary", "list_orders", "list_invoices", "list_payments",
      "list_machines", "list_production_entries", "list_downtime_events", "list_maintenance_events", "list_alerts", "list_notifications",
      "list_customers", "list_suppliers", "list_expenses", "list_customer_debts", "list_supplier_debts", "company_info",
      "profit_report"].includes(value.intent)) {
      return { ...value, intent: value.intent, model: answer.model };
    }
    // Purchase intent
    if (value.intent === "record_purchase" && String(value.item || "").trim() && Number(value.quantity) > 0 && Number(value.totalCost) > 0) {
      return { intent: "record_purchase", item: String(value.item).trim(), quantity: Number(value.quantity), unit: String(value.unit || "kg"), totalCost: Number(value.totalCost), supplier: String(value.supplier || ""), paymentStatus: String(value.paymentStatus || "PAID"), model: answer.model };
    }
    // Expense intent
    if (value.intent === "record_expense" && String(value.category || "").trim() && Number(value.amount) > 0) {
      return { intent: "record_expense", category: String(value.category).toUpperCase(), description: String(value.description || ""), amount: Number(value.amount), model: answer.model };
    }
    // Debt intents
    if (value.intent === "customer_debt" && Number(value.amountOwed) > 0) {
      return { intent: "customer_debt", customerName: String(value.customerName || value.name || "").trim(), amountOwed: Number(value.amountOwed), model: answer.model };
    }
    if (value.intent === "supplier_debt" && Number(value.amountOwed) > 0) {
      return { intent: "supplier_debt", supplierName: String(value.supplierName || value.name || "").trim(), amountOwed: Number(value.amountOwed), model: answer.model };
    }
    // Write intents with entity lookup
    if (value.intent === "add_user") {
      return { intent: "add_user", name: String(value.name || "").trim(), phone: String(value.phone || "").trim(), role: String(value.role || "OPERATOR").toUpperCase(), model: answer.model };
    }
    if (value.intent === "update_user_role") {
      return { intent: "update_user_role", name: String(value.name || "").trim(), role: String(value.role || "").toUpperCase(), model: answer.model };
    }
    if (value.intent === "delete_user") {
      return { intent: "delete_user", name: String(value.name || "").trim(), model: answer.model };
    }
    if (value.intent === "update_machine_status") {
      return { intent: "update_machine_status", machine: String(value.machine || value.machine_no || "").trim(), status: String(value.status || "").toUpperCase(), model: answer.model };
    }
    if (value.intent === "update_order_status") {
      return { intent: "update_order_status", order: String(value.order || "").trim(), status: String(value.status || "").toUpperCase(), model: answer.model };
    }
    if (value.intent === "acknowledge_alert") {
      return { intent: "acknowledge_alert", alert: String(value.alert || "").trim(), model: answer.model };
    }
    if (value.intent === "assign_alert") {
      return { intent: "assign_alert", alert: String(value.alert || "").trim(), name: String(value.name || "").trim(), model: answer.model };
    }
    if (value.intent === "resolve_alert") {
      return { intent: "resolve_alert", alert: String(value.alert || "").trim(), model: answer.model };
    }
    if (value.intent === "create_invoice") {
      return { intent: "create_invoice", order: String(value.order || "").trim(), amount: Number(value.amount || 0), model: answer.model };
    }
    if (value.intent === "update_invoice_status") {
      return { intent: "update_invoice_status", invoice: String(value.invoice || "").trim(), status: String(value.status || "").toUpperCase(), model: answer.model };
    }
    if (value.intent === "add_customer") {
      return { intent: "add_customer", name: String(value.name || "").trim(), phone: String(value.phone || "").trim(), model: answer.model };
    }
    if (value.intent === "update_customer") {
      return { intent: "update_customer", name: String(value.name || "").trim(), newName: String(value.newName || value.name || "").trim(), phone: String(value.phone || "").trim(), model: answer.model };
    }
    if (value.intent === "delete_customer") {
      return { intent: "delete_customer", name: String(value.name || "").trim(), model: answer.model };
    }
  } catch (err) {
    console.error("AI structured extraction error:", err.message);
  }
  return null;
}

async function testAiProvider() {
  if (activeAiProvider() === "nvidia") {
    try {
      const answer = await askNvidia("Reply with one short sentence confirming the AI connection works.");
      return { ok: true, status: "CONNECTED", provider: "NVIDIA NIM", model: answer.model };
    } catch (err) {
      return { ok: false, status: "ERROR", provider: "NVIDIA NIM", error: err.message, model: nvidiaModel() };
    }
  }
  if (!openRouterConfigured()) return { ok: false, status: "CONFIGURATION REQUIRED", models: openRouterModels() };
  try {
    const answer = await askOpenRouter("Reply with one short sentence confirming the AI connection works.");
    return { ok: true, status: "CONNECTED", provider: "OpenRouter", model: answer.model, models: openRouterModels() };
  } catch (err) {
    return { ok: false, status: "ERROR", provider: "OpenRouter", error: err.message, models: openRouterModels() };
  }
}

async function handleAiMessage({ message, language = "English", channel = "WEB", phone = "+254700000001", userId = null, structuredAction = null, aiTimeoutMs = 20_000 }) {
  const user = userId ? get("SELECT * FROM users WHERE id = :id", { id: userId }) : findUserByPhone(phone);
  if (!structuredAction) {
    const toolResult = await runToolAgent(message, language, user?.id || null, channel, aiTimeoutMs);
    if (toolResult) {
      const conversationId = id("conv");
      const activeCompanyId = companyId();
      if (activeCompanyId) {
        run("INSERT INTO ai_conversations VALUES (:id,:company_id,:user_id,:channel,:message,:response,:created_at)", {
          id: conversationId, company_id: activeCompanyId, user_id: user?.id || "", channel, message: String(message || ""), response: toolResult.response, created_at: now()
        });
        run("INSERT INTO ai_actions VALUES (:id,:company_id,:conversation_id,:intent,:structured_json,:requires_confirmation,:confirmed,:status,:created_at)", {
          id: id("aia"), company_id: activeCompanyId, conversation_id: conversationId, intent: toolResult.structured.intent, structured_json: JSON.stringify(toolResult.structured), requires_confirmation: 0, confirmed: 1, status: "APPLIED", created_at: now()
        });
      }
      if (channel === "SMS") sendNotification({ channel: "SMS", recipient: phone, message: toolResult.response, provider: "africastalking" });
      return toolResult;
    }
  }
  const pendingKey = `${channel}:${phone}`;
  const pending = pendingActions.get(pendingKey);
  let structured = structuredAction && typeof structuredAction === "object"
    ? structuredAction
    : await extractStructuredAction(message, pending);
  let response = "";
  let result = null;
  let aiModel = null;
  let requiresConfirmation = 0;
  if (!structured) structured = { intent: "unknown", text: String(message || "") };
  aiModel = structured.model || null;
  delete structured.model;
  if (pending && structured.intent !== "sale_missing_details") pendingActions.delete(pendingKey);
  if (structured.intent === "setup_workspace") {
    result = setupWorkspaceFromAgent(structured);
    response = `Workspace created for ${result.company.name} in ${result.company.city}. You can now configure products, materials, machines, and production jobs through the agent.`;
  } else if (structured.intent === "sale") {
    try {
      result = withTransaction(() => createSale({
        itemName: structured.item, quantity: structured.quantity, unit: structured.unit, amount: structured.amount,
        source: channel, userId: user?.id, originalMessage: message, structured
      }));
      response = `Sale recorded: ${result.quantity}${result.unit} of ${result.itemName} sold for KSh ${result.amount.toLocaleString()}. Remaining stock: ${result.remaining}${result.unit}.`;
    } catch (error) {
      if (/Configure the business workspace/.test(error.message)) {
        response = "Workspace setup is required before I can record this sale. Open Workspace Setup and add your company, owner, and the material you want to track.";
        structured = { ...structured, intent: "setup_required", error: error.message };
      } else if (/Inventory item not found/.test(error.message)) {
        response = `I understood the sale, but ${structured.item} is not configured in inventory yet. Add it as a material before I record this sale.`;
        structured = { ...structured, intent: "sale_missing_inventory", error: error.message };
      } else {
        throw error;
      }
    }
  } else if (structured.intent === "sale_missing_details") {
    pendingActions.set(pendingKey, structured);
    response = `I understood that you sold ${structured.quantity}${structured.unit} of ${structured.item}. I still need the sale amount before I can record it.`;
  } else if (structured.intent === "production_update") {
    result = withTransaction(() => createProductionEntry({
      productName: structured.product, quantityProduced: structured.quantity_produced, materialName: structured.material,
      quantityConsumed: structured.quantity_consumed, unit: structured.unit, source: channel, userId: user?.id, originalMessage: message, structured
    }));
    const material = get("SELECT * FROM inventory WHERE lower(item_name) = lower(:item)", { item: structured.material });
    response = `Recorded: ${structured.quantity_consumed}${structured.unit} ${structured.material.toLowerCase()} consumed and ${structured.quantity_produced} ${result.product.toLowerCase()} produced.${material ? ` ${material.item_name} remaining: ${material.quantity}${material.unit}.` : ""}`;
  } else if (structured.intent === "configure") {
    result = withTransaction(() => configureRecord({
      ...structured, source: channel, userId: user?.id, originalMessage: message, structured
    }));
    response = `Configuration completed: ${result.target} ${result.name || result.product || result.machineNo} is now available in Biashara OS.`;
  } else if (structured.intent === "machine_downtime") {
    result = createDowntime({ machineName: structured.machine, source: channel, userId: user?.id, originalMessage: message, structured });
    response = `Recorded: ${result.machine} is DOWN. SMS sent to ${result.technician}. Voice escalation is ready if not acknowledged.`;
  } else if (structured.intent === "inventory_query") {
    const inv = get("SELECT * FROM inventory WHERE item_name = :item", { item: structured.item });
    response = inv
      ? `${inv.item_name}: ${inv.quantity}${inv.unit} in stock. Reorder level: ${inv.reorder_level}${inv.unit}.`
      : `${structured.item} is not configured in inventory yet.`;
  } else if (structured.intent === "business_summary") {
    result = getBusinessSummary();
    response = `This week you produced ${result.unitsProduced} units and completed ${result.completedOrders} orders. Revenue was KSh ${result.revenue.toLocaleString()}. Steel consumption was ${result.steelConsumed}kg. Machine downtime is ${result.downtimeHours} hours. Biggest issue: ${result.biggestIssue}. Recommendation: ${result.recommendation}`;
  } else if (structured.intent === "sales_summary") {
    const top = getSalesSummary();
    response = top ? `${top.product_name} is selling best with ${top.qty} units ordered.` : "No sales yet this week.";
  } else if (structured.intent === "machine_performance") {
    const perf = getMachinePerformance();
    response = perf ? `${perf.machine_no} has the most downtime: ${Number(perf.minutes || 0).toFixed(1)} minutes.` : "No downtime recorded.";
  } else if (structured.intent === "order_query") {
    const order = get("SELECT o.*, c.name AS customer FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 1");
    response = order ? `${order.order_no} for ${order.customer} is ${order.status}. Balance: KSh ${getOutstanding(order.id).toLocaleString()}.` : "No orders are recorded yet.";
  } else if (structured.intent === "list_users") {
    const users = listUsers();
    response = users.length > 0 ? `Team (${users.length} members):\n` + users.map(u => `${u.name} - ${u.role} (${u.phone})`).join("\n") : "No team members configured yet.";
  } else if (structured.intent === "list_products") {
    const products = listProducts();
    response = products.length > 0 ? `Products (${products.length}):\n` + products.map(p => `${p.name} (${p.sku}) - KSh ${Number(p.selling_price).toLocaleString()} ${p.unit} - Stock: ${p.stock ?? 0}`).join("\n") : "No products configured yet.";
  } else if (structured.intent === "list_materials") {
    const materials = listMaterials();
    response = materials.length > 0 ? `Materials (${materials.length}):\n` + materials.map(m => `${m.name} - ${m.stock ?? 0}${m.unit} (reorder: ${m.reorder_level}${m.unit}) - Supplier: ${m.supplier || 'N/A'}`).join("\n") : "No materials configured yet.";
  } else if (structured.intent === "inventory_summary") {
    const items = inventorySummary();
    response = items.length > 0 ? `Inventory (${items.length} items):\n` + items.map(i => `${i.item_name} (${i.item_type}): ${i.quantity}${i.unit} - Reorder: ${i.reorder_level}${i.unit}`).join("\n") : "No inventory records yet.";
  } else if (structured.intent === "list_orders") {
    const orders = listOrders();
    response = orders.length > 0 ? `Orders (${orders.length}):\n` + orders.map(o => `${o.order_no} - ${o.customer} - ${o.status} - KSh ${Number(o.total_amount).toLocaleString()} - Invoice: ${o.invoice_status || 'N/A'}`).join("\n") : "No orders recorded yet.";
  } else if (structured.intent === "list_invoices") {
    const invoices = listInvoices();
    response = invoices.length > 0 ? `Invoices (${invoices.length}):\n` + invoices.map(i => `${i.invoice_no} - ${i.customer} - KSh ${Number(i.amount).toLocaleString()} - ${i.status}`).join("\n") : "No invoices recorded yet.";
  } else if (structured.intent === "list_payments") {
    const payments = listPayments();
    response = payments.length > 0 ? `Payments (${payments.length}):\n` + payments.map(p => `${p.invoice_no} - KSh ${Number(p.amount).toLocaleString()} - ${p.status} - ${p.provider} (${p.created_at})`).join("\n") : "No payments recorded yet.";
  } else if (structured.intent === "list_machines") {
    const machines = listMachines();
    response = machines.length > 0 ? `Machines (${machines.length}):\n` + machines.map(m => `${m.machine_no} ${m.name} - ${m.status} - Location: ${m.location} - Tech: ${m.technician || 'Unassigned'}`).join("\n") : "No machines configured yet.";
  } else if (structured.intent === "list_production_entries") {
    const entries = listProductionEntries();
    response = entries.length > 0 ? `Production entries (${entries.length}):\n` + entries.map(e => `${e.product_name}: ${e.quantity_produced} units - ${e.job_no || 'No job'} - ${e.source} (${e.created_at})`).join("\n") : "No production entries recorded yet.";
  } else if (structured.intent === "list_downtime_events") {
    const events = listDowntimeEvents();
    response = events.length > 0 ? `Downtime events (${events.length}):\n` + events.map(e => `${e.machine_no} ${e.machine_name} - ${e.status} - Tech: ${e.technician || 'N/A'} - Escalation: ${e.escalation_level} (${e.created_at})`).join("\n") : "No downtime events recorded.";
  } else if (structured.intent === "list_maintenance_events") {
    const events = listMaintenanceEvents();
    response = events.length > 0 ? `Maintenance history (${events.length}):\n` + events.map(e => `${e.machine_no} ${e.machine_name} - ${e.event_type} - ${e.note || ''} (${e.created_at})`).join("\n") : "No maintenance events recorded.";
  } else if (structured.intent === "list_alerts") {
    const alerts = listAlerts();
    response = alerts.length > 0 ? `Alerts (${alerts.length}):\n` + alerts.map(a => `[${a.severity}] ${a.title} - ${a.status} - ${a.message.slice(0, 80)} - Assigned: ${a.assigned_user || 'Unassigned'}`).join("\n") : "No alerts.";
  } else if (structured.intent === "list_notifications") {
    const notifs = listNotifications();
    response = notifs.length > 0 ? `Notifications (${notifs.length}):\n` + notifs.map(n => `${n.channel} to ${n.recipient} - ${n.status} - ${n.message.slice(0, 60)} (${n.created_at})`).join("\n") : "No notifications sent yet.";
  } else if (structured.intent === "list_customers") {
    const customers = listCustomers();
    response = customers.length > 0 ? `Customers (${customers.length}):\n` + customers.map(c => `${c.name} - ${c.phone || 'No phone'}`).join("\n") : "No customers configured yet.";
  } else if (structured.intent === "list_suppliers") {
    const suppliers = listSuppliers();
    response = suppliers.length > 0 ? `Suppliers (${suppliers.length}):\n` + suppliers.map(s => `${s.name} - ${s.phone || 'No phone'}`).join("\n") : "No suppliers configured yet.";
  } else if (structured.intent === "list_expenses") {
    const expenses = listExpenses("week");
    const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    response = expenses.length > 0 ? `This week's expenses (${expenses.length}):\n` + expenses.map(e => `${e.category} - KSh ${Number(e.amount).toLocaleString()} - ${e.description || 'No description'}`).join("\n") + `\n\nTotal: KSh ${total.toLocaleString()}` : "No expenses recorded this week.";
  } else if (structured.intent === "list_customer_debts") {
    const debts = getCustomerDebts();
    const total = debts.reduce((sum, d) => sum + (Number(d.amount_owed) - Number(d.amount_paid)), 0);
    response = debts.length > 0 ? `Customer receivables (${debts.length}):\n` + debts.map(d => `${d.customer_name} - KSh ${(Number(d.amount_owed) - Number(d.amount_paid)).toLocaleString()} - ${d.status}`).join("\n") + `\n\nTotal: KSh ${total.toLocaleString()}` : "No customer debts.";
  } else if (structured.intent === "list_supplier_debts") {
    const debts = getSupplierPayables();
    const total = debts.reduce((sum, d) => sum + (Number(d.amount_owed) - Number(d.amount_paid)), 0);
    response = debts.length > 0 ? `Supplier payables (${debts.length}):\n` + debts.map(d => `${d.supplier_name} - KSh ${(Number(d.amount_owed) - Number(d.amount_paid)).toLocaleString()} - ${d.status}`).join("\n") + `\n\nTotal: KSh ${total.toLocaleString()}` : "No supplier payables.";
  } else if (structured.intent === "record_purchase") {
    try {
      result = withTransaction(() => recordPurchase({
        supplierName: structured.supplier, itemName: structured.item, quantity: structured.quantity,
        unit: structured.unit || "kg", totalCost: structured.totalCost, paymentStatus: structured.paymentStatus || "PAID",
        source: channel, userId: user?.id, originalMessage: message
      }));
      response = `Purchase recorded: ${result.quantity}${result.unit} of ${result.itemName} from ${result.supplier || "supplier"} for KSh ${result.totalCost.toLocaleString()}. Stock now updated.${result.paymentStatus === "CREDIT" ? " Supplier payable created." : ""}`;
    } catch (error) {
      if (/Inventory item not found/.test(error.message)) {
        response = `I understood the purchase, but ${structured.item} is not configured as a material yet. Add it in Setup first, then re-record this purchase.`;
      } else {
        response = `Could not record purchase: ${error.message}`;
      }
    }
  } else if (structured.intent === "record_expense") {
    try {
      result = withTransaction(() => recordExpense({
        category: structured.category, description: structured.description, amount: structured.amount, userId: user?.id, source: channel
      }));
      response = `Expense recorded: KSh ${result.amount.toLocaleString()} for ${result.category.toLowerCase()}${result.description ? ` (${result.description})` : ''}.`;
    } catch (error) {
      response = `Could not record expense: ${error.message}`;
    }
  } else if (structured.intent === "customer_debt") {
    try {
      const customer = findCustomer(structured.customerName);
      if (!customer) {
        response = `Customer "${structured.customerName}" not found. First add the customer, then record the debt.`;
      } else {
        result = withTransaction(() => createCustomerDebt({
          customerId: customer.id, amountOwed: structured.amountOwed, source: channel
        }));
        response = `Debt recorded: ${customer.name} owes KSh ${structured.amountOwed.toLocaleString()}. Status: UNPAID.`;
      }
    } catch (error) {
      response = `Could not record customer debt: ${error.message}`;
    }
  } else if (structured.intent === "supplier_debt") {
    try {
      const supplier = findSupplier(structured.supplierName);
      if (!supplier) {
        response = `Supplier "${structured.supplierName}" not found. First add the supplier, then record the debt.`;
      } else {
        result = withTransaction(() => createSupplierDebt({
          supplierId: supplier.id, amountOwed: structured.amountOwed, source: channel
        }));
        response = `Payable recorded: You owe ${supplier.name} KSh ${structured.amountOwed.toLocaleString()}. Status: UNPAID.`;
      }
    } catch (error) {
      response = `Could not record supplier debt: ${error.message}`;
    }
  } else if (structured.intent === "profit_report") {
    const pl = getProfitAndLoss(structured.period || "week");
    response = `This week: Revenue KSh ${pl.revenue.toLocaleString()} - Expenses KSh ${pl.expenses.toLocaleString()} = Profit KSh ${pl.profit.toLocaleString()} (Margin: ${pl.profitMargin}%).`;
  } else if (structured.intent === "add_supplier") {
    try {
      result = withTransaction(() => addSupplier({ name: structured.name, phone: structured.phone, source: channel }));
      response = `Supplier added: ${result.name}${result.phone ? ' - ' + result.phone : ''}.`;
    } catch (error) {
      response = `Could not add supplier: ${error.message}`;
    }
  } else if (structured.intent === "company_info") {
    const info = getCompanyInfo();
    response = info ? `Company: ${info.name}\nCity: ${info.city}\nTeam: ${info.userCount} members\nProducts: ${info.productCount}\nMaterials: ${info.materialCount}` : "No company configured yet. Use workspace setup to get started.";
  } else if (structured.intent === "add_user") {
    try {
      result = withTransaction(() => addUser({ name: structured.name, phone: structured.phone, role: structured.role }));
      response = `User added: ${result.name} (${result.role}) - ${result.phone}.`;
    } catch (error) {
      response = `Could not add user: ${error.message}`;
    }
  } else if (structured.intent === "update_user_role") {
    try {
      const target = findUser(structured.name);
      if (!target) { response = `User "${structured.name}" not found. Check the name and try again.`; }
      else {
        result = withTransaction(() => updateUserRole(target.id, structured.role));
        response = `${result.name} role changed from ${result.oldRole} to ${result.newRole}.`;
      }
    } catch (error) {
      response = `Could not update user role: ${error.message}`;
    }
  } else if (structured.intent === "delete_user") {
    try {
      const target = findUser(structured.name);
      if (!target) { response = `User "${structured.name}" not found.`; }
      else {
        result = withTransaction(() => deleteUser(target.id));
        response = `User ${result.name} has been removed.`;
      }
    } catch (error) {
      response = `Could not delete user: ${error.message}`;
    }
  } else if (structured.intent === "update_machine_status") {
    try {
      const machine = findMachine(structured.machine);
      if (!machine) { response = `Machine "${structured.machine || 'unknown'}" not found. Check the machine number and try again.`; }
      else {
        result = withTransaction(() => updateMachineStatus(machine.id, structured.status));
        response = `${result.machineNo} status changed from ${result.oldStatus} to ${result.newStatus}.`;
      }
    } catch (error) {
      response = `Could not update machine: ${error.message}`;
    }
  } else if (structured.intent === "update_order_status") {
    try {
      const order = findOrder(structured.order);
      if (!order) { response = `Order "${structured.order || 'unknown'}" not found. Check the order number and try again.`; }
      else {
        result = withTransaction(() => updateOrderStatus(order.id, structured.status));
        response = `${result.orderNo} status changed from ${result.oldStatus} to ${result.newStatus}.`;
      }
    } catch (error) {
      response = `Could not update order: ${error.message}`;
    }
  } else if (structured.intent === "acknowledge_alert") {
    try {
      const alert = findAlert(structured.alert);
      if (!alert) { response = `Alert "${structured.alert || 'unknown'}" not found.`; }
      else {
        result = withTransaction(() => acknowledgeAlert(alert.id, user?.id));
        response = `Alert "${result.title}" acknowledged.`;
      }
    } catch (error) {
      response = `Could not acknowledge alert: ${error.message}`;
    }
  } else if (structured.intent === "assign_alert") {
    try {
      const alert = findAlert(structured.alert);
      const target = findUser(structured.name);
      if (!alert) { response = `Alert "${structured.alert || 'unknown'}" not found.`; }
      else if (!target) { response = `User "${structured.name}" not found.`; }
      else {
        result = withTransaction(() => assignAlert(alert.id, target.id));
        response = `Alert "${result.title}" assigned to ${result.assignedTo}.`;
      }
    } catch (error) {
      response = `Could not assign alert: ${error.message}`;
    }
  } else if (structured.intent === "resolve_alert") {
    try {
      const alert = findAlert(structured.alert);
      if (!alert) { response = `Alert "${structured.alert || 'unknown'}" not found.`; }
      else {
        result = withTransaction(() => resolveAlert(alert.id));
        response = `Alert "${result.title}" resolved.`;
      }
    } catch (error) {
      response = `Could not resolve alert: ${error.message}`;
    }
  } else if (structured.intent === "create_invoice") {
    try {
      result = withTransaction(() => createInvoiceExplicit({ orderId: structured.order ? findOrder(structured.order)?.id : undefined, amount: structured.amount }));
      response = `Invoice ${result.invoiceNo} created for order ${result.orderNo}. Amount: KSh ${Number(result.amount).toLocaleString()}.`;
    } catch (error) {
      response = `Could not create invoice: ${error.message}`;
    }
  } else if (structured.intent === "update_invoice_status") {
    try {
      const invoice = findInvoice(structured.invoice);
      if (!invoice) { response = `Invoice "${structured.invoice || 'unknown'}" not found.`; }
      else {
        result = withTransaction(() => updateInvoiceStatus(invoice.id, structured.status));
        response = `${result.invoiceNo} status changed from ${result.oldStatus} to ${result.newStatus}.`;
      }
    } catch (error) {
      response = `Could not update invoice: ${error.message}`;
    }
  } else if (structured.intent === "add_customer") {
    try {
      result = withTransaction(() => addCustomerExplicit({ name: structured.name, phone: structured.phone }));
      response = `Customer added: ${result.name}${result.phone ? ' - ' + result.phone : ''}.`;
    } catch (error) {
      response = `Could not add customer: ${error.message}`;
    }
  } else if (structured.intent === "update_customer") {
    try {
      const customer = findCustomer(structured.name);
      if (!customer) { response = `Customer "${structured.name}" not found.`; }
      else {
        result = withTransaction(() => updateCustomer(customer.id, { name: structured.newName || structured.name, phone: structured.phone }));
        response = `Customer updated: ${result.name}${result.phone ? ' - ' + result.phone : ''}.`;
      }
    } catch (error) {
      response = `Could not update customer: ${error.message}`;
    }
  } else if (structured.intent === "delete_customer") {
    try {
      const customer = findCustomer(structured.name);
      if (!customer) { response = `Customer "${structured.name}" not found.`; }
      else {
        result = withTransaction(() => deleteCustomer(customer.id));
        response = `Customer ${result.name} has been removed.`;
      }
    } catch (error) {
      response = `Could not delete customer: ${error.message}`;
    }
  } else {
    try {
      const answer = await askAiProvider(message, language);
      response = answer?.text || "I could not safely interpret that request.";
      aiModel = answer?.model || null;
    } catch (err) {
      response = "The AI provider is temporarily unavailable. Try again, or use a production, stock, order, or machine command.";
      console.error("AI provider error:", err.message);
    }
  }
  const conversationId = id("conv");
  const activeCompanyId = companyId();
  // A user can chat before completing workspace setup; in that case there is no
  // tenant to audit against yet, so return the answer without writing audit rows.
  if (activeCompanyId) {
    run("INSERT INTO ai_conversations VALUES (:id,:company_id,:user_id,:channel,:message,:response,:created_at)", {
      id: conversationId, company_id: activeCompanyId, user_id: user?.id || "", channel, message: String(message || ""), response, created_at: now()
    });
    run("INSERT INTO ai_actions VALUES (:id,:company_id,:conversation_id,:intent,:structured_json,:requires_confirmation,:confirmed,:status,:created_at)", {
      id: id("aia"), company_id: activeCompanyId, conversation_id: conversationId, intent: structured.intent, structured_json: JSON.stringify(structured),
      requires_confirmation: requiresConfirmation, confirmed: requiresConfirmation ? 0 : 1, status: ["unknown", "sale_missing_details", "sale_missing_inventory"].includes(structured.intent) ? "NEEDS_DETAILS" : "APPLIED", created_at: now()
    });
  }
  if (channel === "SMS") sendNotification({ channel: "SMS", recipient: phone, message: response, provider: "africastalking" });
  return { response, structured, result, provider: ["unknown", "sale_missing_details", "sale_missing_inventory"].includes(structured.intent) ? activeAiProvider() : "local", model: aiModel };
}

function getOutstanding(orderId) {
  const inv = get("SELECT * FROM invoices WHERE order_id=:id", { id: orderId });
  if (!inv) return 0;
  return inv.status === "PAID" ? 0 : Number(inv.amount);
}

function getSalesSummary() {
  return get("SELECT product_name, SUM(quantity) AS qty FROM order_items GROUP BY product_name ORDER BY qty DESC LIMIT 1");
}

function getMachinePerformance() {
  return get("SELECT machine_no, name, total_downtime_minutes + COALESCE((SELECT SUM(COALESCE(downtime_minutes, 0)) FROM downtime_events WHERE machine_id = machines.id),0) AS minutes FROM machines ORDER BY minutes DESC LIMIT 1");
}

function listUsers() {
  return all("SELECT id, name, phone, role, created_at FROM users ORDER BY role, name");
}

function listProducts() {
  return all("SELECT p.*, (SELECT quantity FROM inventory WHERE item_id = p.id AND item_type = 'FINISHED_GOOD') AS stock FROM products p ORDER BY p.name");
}

function listMaterials() {
  return all("SELECT m.*, (SELECT quantity FROM inventory WHERE item_id = m.id AND item_type = 'RAW_MATERIAL') AS stock FROM materials m ORDER BY m.name");
}

function inventorySummary() {
  return all("SELECT * FROM inventory ORDER BY item_type, item_name");
}

function listOrders() {
  return all("SELECT o.*, c.name AS customer, i.invoice_no, i.amount AS invoice_amount, i.status AS invoice_status FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN invoices i ON i.order_id = o.id ORDER BY o.created_at DESC");
}

function listInvoices() {
  return all("SELECT i.*, o.order_no, c.name AS customer FROM invoices i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id ORDER BY i.issued_at DESC");
}

function listPayments() {
  return all("SELECT p.*, i.invoice_no FROM payments p JOIN invoices i ON i.id = p.invoice_id ORDER BY p.created_at DESC");
}

function listMachines() {
  return all("SELECT m.*, u.name AS technician, op.name AS operator FROM machines m LEFT JOIN users u ON u.id = m.technician_id LEFT JOIN users op ON op.id = m.current_operator_id ORDER BY m.machine_no");
}

function listProductionEntries() {
  return all("SELECT pe.*, pj.job_no FROM production_entries pe LEFT JOIN production_jobs pj ON pj.id = pe.production_job_id ORDER BY pe.created_at DESC LIMIT 30");
}

function listDowntimeEvents() {
  return all("SELECT de.*, m.machine_no, m.name AS machine_name, u.name AS technician FROM downtime_events de JOIN machines m ON m.id = de.machine_id LEFT JOIN users u ON u.id = de.technician_id ORDER BY de.created_at DESC");
}

function listMaintenanceEvents() {
  return all("SELECT me.*, m.machine_no, m.name AS machine_name, u.name AS technician FROM maintenance_events me JOIN machines m ON m.id = me.machine_id LEFT JOIN users u ON u.id = me.technician_id ORDER BY me.created_at DESC");
}

function listAlerts() {
  return all("SELECT a.*, u.name AS assigned_user FROM alerts a LEFT JOIN users u ON u.id = a.assigned_user_id ORDER BY a.created_at DESC");
}

function listNotifications() {
  return all("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 30");
}

function listCustomers() {
  return all("SELECT * FROM customers ORDER BY name");
}

function getCompanyInfo() {
  const company = get("SELECT * FROM companies LIMIT 1");
  if (!company) return null;
  const userCount = get("SELECT COUNT(*) AS v FROM users").v;
  const productCount = get("SELECT COUNT(*) AS v FROM products").v;
  const materialCount = get("SELECT COUNT(*) AS v FROM materials").v;
  return { ...company, userCount, productCount, materialCount };
}

function findUser(name) {
  const lower = String(name || "").toLowerCase();
  return get("SELECT * FROM users WHERE lower(name) LIKE :pattern LIMIT 1", { pattern: `%${lower}%` });
}

function findProduct(name) {
  const lower = String(name || "").toLowerCase();
  return get("SELECT * FROM products WHERE lower(name) LIKE :pattern LIMIT 1", { pattern: `%${lower}%` });
}

function findMaterial(name) {
  const lower = String(name || "").toLowerCase();
  return get("SELECT * FROM materials WHERE lower(name) LIKE :pattern LIMIT 1", { pattern: `%${lower}%` });
}

function findOrder(orderRef) {
  const lower = String(orderRef || "").toLowerCase();
  return get("SELECT o.*, c.name AS customer FROM orders o JOIN customers c ON c.id = o.customer_id WHERE lower(o.order_no) LIKE :pattern ORDER BY o.created_at DESC LIMIT 1", { pattern: `%${lower}%` });
}

function findMachine(name) {
  const lower = String(name || "").toLowerCase();
  return get("SELECT * FROM machines WHERE lower(machine_no) LIKE :pattern OR lower(name) LIKE :pattern LIMIT 1", { pattern: `%${lower}%` });
}

function findInvoice(invoiceRef) {
  const lower = String(invoiceRef || "").toLowerCase();
  return get("SELECT i.*, o.order_no, c.name AS customer FROM invoices i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id WHERE lower(i.invoice_no) LIKE :pattern ORDER BY i.issued_at DESC LIMIT 1", { pattern: `%${lower}%` });
}

function findAlert(alertRef) {
  const lower = String(alertRef || "").toLowerCase();
  return get("SELECT a.*, u.name AS assigned_user FROM alerts a LEFT JOIN users u ON u.id = a.assigned_user_id WHERE lower(a.id) LIKE :pattern OR lower(a.title) LIKE :pattern ORDER BY a.created_at DESC LIMIT 1", { pattern: `%${lower}%` });
}

function findCustomer(name) {
  const lower = String(name || "").toLowerCase();
  return get("SELECT * FROM customers WHERE lower(name) LIKE :pattern LIMIT 1", { pattern: `%${lower}%` });
}

function addUser({ name, phone, role }) {
  if (!companyId()) throw new Error("Configure the workspace first.");
  const validRoles = ['OWNER','MANAGER','SUPERVISOR','STOREKEEPER','OPERATOR','TECHNICIAN','ACCOUNTANT'];
  const userRole = String(role || "OPERATOR").toUpperCase();
  if (!validRoles.includes(userRole)) throw new Error(`Invalid role: ${userRole}. Valid roles: ${validRoles.join(', ')}`);
  if (!String(name || "").trim()) throw new Error("User name is required.");
  if (!String(phone || "").trim()) throw new Error("Phone number is required.");
  const uid = id("usr");
  run("INSERT INTO users VALUES (:id,:company_id,:name,:phone,:role,:created_at)", {
    id: uid, company_id: companyId(), name: String(name).trim(), phone: String(phone).trim(), role: userRole, created_at: now()
  });
  audit({ action: "addUser", entityType: "user", entityId: uid, after: { name, phone, role: userRole }, source: "AI" });
  return { userId: uid, name: String(name).trim(), phone: String(phone).trim(), role: userRole };
}

function updateUserRole(userId, newRole) {
  const validRoles = ['OWNER','MANAGER','SUPERVISOR','STOREKEEPER','OPERATOR','TECHNICIAN','ACCOUNTANT'];
  const userRole = String(newRole || "").toUpperCase();
  if (!validRoles.includes(userRole)) throw new Error(`Invalid role: ${userRole}. Valid roles: ${validRoles.join(', ')}`);
  const user = get("SELECT * FROM users WHERE id = :id", { id: userId });
  if (!user) throw new Error("User not found.");
  const before = { ...user };
  run("UPDATE users SET role = :role WHERE id = :id", { role: userRole, id: userId });
  audit({ action: "updateUserRole", entityType: "user", entityId: userId, before, after: { ...user, role: userRole }, source: "AI" });
  return { userId, name: user.name, oldRole: user.role, newRole: userRole };
}

function deleteUser(userId) {
  const user = get("SELECT * FROM users WHERE id = :id", { id: userId });
  if (!user) throw new Error("User not found.");
  run("DELETE FROM users WHERE id = :id", { id: userId });
  audit({ action: "deleteUser", entityType: "user", entityId: userId, before: user, source: "AI" });
  return { userId, name: user.name, deleted: true };
}

function updateProduct(productId, data) {
  const product = get("SELECT * FROM products WHERE id = :id", { id: productId });
  if (!product) throw new Error("Product not found.");
  const before = { ...product };
  const name = String(data.name || product.name).trim();
  const unit = String(data.unit || product.unit).trim();
  const price = Number(data.price || data.selling_price || product.selling_price);
  const sku = String(data.sku || product.sku).trim();
  run("UPDATE products SET name=:name, unit=:unit, selling_price=:price, sku=:sku WHERE id=:id", { name, unit, price, sku, id: productId });
  run("UPDATE inventory SET item_name=:name, unit=:unit WHERE item_id=:id AND item_type='FINISHED_GOOD'", { name, unit, id: productId });
  audit({ action: "updateProduct", entityType: "product", entityId: productId, before, after: { ...product, name, unit, selling_price: price, sku }, source: "AI" });
  return { productId, name, unit, price, sku };
}

function deleteProduct(productId) {
  const product = get("SELECT * FROM products WHERE id = :id", { id: productId });
  if (!product) throw new Error("Product not found.");
  run("DELETE FROM inventory WHERE item_id = :id AND item_type = 'FINISHED_GOOD'", { id: productId });
  run("DELETE FROM products WHERE id = :id", { id: productId });
  audit({ action: "deleteProduct", entityType: "product", entityId: productId, before: product, source: "AI" });
  return { productId, name: product.name, deleted: true };
}

function updateMaterial(materialId, data) {
  const material = get("SELECT * FROM materials WHERE id = :id", { id: materialId });
  if (!material) throw new Error("Material not found.");
  const before = { ...material };
  const name = String(data.name || material.name).trim();
  const unit = String(data.unit || material.unit).trim();
  const supplier = String(data.supplier || material.supplier || "").trim();
  const reorderLevel = Number(data.reorder_level || data.reorderLevel || material.reorder_level);
  run("UPDATE materials SET name=:name, unit=:unit, supplier=:supplier, reorder_level=:reorderLevel WHERE id=:id", { name, unit, supplier, reorderLevel, id: materialId });
  run("UPDATE inventory SET item_name=:name, unit=:unit, reorder_level=:reorderLevel WHERE item_id=:id AND item_type='RAW_MATERIAL'", { name, unit, reorderLevel, id: materialId });
  audit({ action: "updateMaterial", entityType: "material", entityId: materialId, before, after: { ...material, name, unit, supplier, reorder_level: reorderLevel }, source: "AI" });
  return { materialId, name, unit, supplier, reorderLevel };
}

function deleteMaterial(materialId) {
  const material = get("SELECT * FROM materials WHERE id = :id", { id: materialId });
  if (!material) throw new Error("Material not found.");
  run("DELETE FROM inventory WHERE item_id = :id AND item_type = 'RAW_MATERIAL'", { id: materialId });
  run("DELETE FROM materials WHERE id = :id", { id: materialId });
  audit({ action: "deleteMaterial", entityType: "material", entityId: materialId, before: material, source: "AI" });
  return { materialId, name: material.name, deleted: true };
}

function updateOrderStatus(orderId, status) {
  const validStatuses = ['IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED'];
  const orderStatus = String(status || "").toUpperCase();
  if (!validStatuses.includes(orderStatus)) throw new Error(`Invalid status: ${orderStatus}. Valid: ${validStatuses.join(', ')}`);
  const order = get("SELECT * FROM orders WHERE id = :id", { id: orderId });
  if (!order) throw new Error("Order not found.");
  const before = { ...order };
  run("UPDATE orders SET status = :status, updated_at = :updated_at WHERE id = :id", { status: orderStatus, updated_at: now(), id: orderId });
  audit({ action: "updateOrderStatus", entityType: "order", entityId: orderId, before, after: { ...order, status: orderStatus }, source: "AI" });
  return { orderId, orderNo: order.order_no, oldStatus: order.status, newStatus: orderStatus };
}

function updateMachineStatus(machineId, status) {
  const validStatuses = ['RUNNING', 'IDLE', 'DOWN', 'MAINTENANCE'];
  const machineStatus = String(status || "").toUpperCase();
  if (!validStatuses.includes(machineStatus)) throw new Error(`Invalid status: ${machineStatus}. Valid: ${validStatuses.join(', ')}`);
  const machine = get("SELECT * FROM machines WHERE id = :id", { id: machineId });
  if (!machine) throw new Error("Machine not found.");
  const before = { ...machine };
  run("UPDATE machines SET status = :status, updated_at = :updated_at WHERE id = :id", { status: machineStatus, updated_at: now(), id: machineId });
  run("INSERT INTO maintenance_events VALUES (:id,:company_id,:machine_id,'STATUS_CHANGE',:note,:technician_id,:created_at)", {
    id: id("maint"), company_id: companyId(), machine_id: machineId, note: `Status changed from ${machine.status} to ${machineStatus}`, technician_id: machine.technician_id, created_at: now()
  });
  audit({ action: "updateMachineStatus", entityType: "machine", entityId: machineId, before, after: { ...machine, status: machineStatus }, source: "AI" });
  return { machineId, machineNo: machine.machine_no, oldStatus: machine.status, newStatus: machineStatus };
}

function acknowledgeAlert(alertId, userId) {
  const alert = get("SELECT * FROM alerts WHERE id = :id", { id: alertId });
  if (!alert) throw new Error("Alert not found.");
  run("UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_at = :now, assigned_user_id = COALESCE(:userId, assigned_user_id) WHERE id = :id", { now: now(), userId, id: alertId });
  audit({ action: "acknowledgeAlert", entityType: "alert", entityId: alertId, after: { status: "ACKNOWLEDGED" }, source: "AI" });
  return { alertId, title: alert.title, status: "ACKNOWLEDGED" };
}

function assignAlert(alertId, userId) {
  const alert = get("SELECT * FROM alerts WHERE id = :id", { id: alertId });
  if (!alert) throw new Error("Alert not found.");
  const user = get("SELECT * FROM users WHERE id = :id", { id: userId });
  if (!user) throw new Error("User not found.");
  run("UPDATE alerts SET assigned_user_id = :userId WHERE id = :id", { userId, id: alertId });
  audit({ action: "assignAlert", entityType: "alert", entityId: alertId, after: { assigned_user_id: userId, assigned_to: user.name }, source: "AI" });
  return { alertId, title: alert.title, assignedTo: user.name };
}

function resolveAlert(alertId) {
  const alert = get("SELECT * FROM alerts WHERE id = :id", { id: alertId });
  if (!alert) throw new Error("Alert not found.");
  run("UPDATE alerts SET status = 'RESOLVED' WHERE id = :id", { id: alertId });
  audit({ action: "resolveAlert", entityType: "alert", entityId: alertId, after: { status: "RESOLVED" }, source: "AI" });
  return { alertId, title: alert.title, status: "RESOLVED" };
}

function createInvoiceExplicit({ orderId, amount }) {
  if (!orderId && !amount) throw new Error("Order ID or amount is required.");
  let order = orderId ? get("SELECT * FROM orders WHERE id = :id", { id: orderId }) : null;
  if (!order) order = get("SELECT * FROM orders WHERE status != 'COMPLETED' ORDER BY created_at DESC LIMIT 1");
  if (!order) throw new Error("No order found for invoicing.");
  const invAmount = Number(amount || order.total_amount);
  const count = get("SELECT COUNT(*) AS c FROM invoices").c + 1001;
  const invoiceId = id("inv");
  run("INSERT INTO invoices VALUES (:id,:company_id,:invoice_no,:order_id,:amount,'UNPAID',:issued_at,NULL)", {
    id: invoiceId, company_id: companyId(), invoice_no: `INV-${count}`, order_id: order.id, amount: invAmount, issued_at: now()
  });
  audit({ action: "createInvoice", entityType: "invoice", entityId: invoiceId, after: { orderNo: order.order_no, amount: invAmount }, source: "AI" });
  return { invoiceId, invoiceNo: `INV-${count}`, orderNo: order.order_no, amount: invAmount };
}

function updateInvoiceStatus(invoiceId, status) {
  const validStatuses = ['UNPAID', 'PAID', 'CANCELLED'];
  const invStatus = String(status || "").toUpperCase();
  if (!validStatuses.includes(invStatus)) throw new Error(`Invalid status: ${invStatus}. Valid: ${validStatuses.join(', ')}`);
  const invoice = get("SELECT * FROM invoices WHERE id = :id", { id: invoiceId });
  if (!invoice) throw new Error("Invoice not found.");
  const before = { ...invoice };
  run("UPDATE invoices SET status = :status, paid_at = CASE WHEN :status = 'PAID' THEN :now ELSE paid_at END WHERE id = :id", { status: invStatus, now: now(), id: invoiceId });
  audit({ action: "updateInvoiceStatus", entityType: "invoice", entityId: invoiceId, before, after: { ...invoice, status: invStatus }, source: "AI" });
  return { invoiceId, invoiceNo: invoice.invoice_no, oldStatus: invoice.status, newStatus: invStatus };
}

function addCustomerExplicit({ name, phone }) {
  if (!companyId()) throw new Error("Configure the workspace first.");
  if (!String(name || "").trim()) throw new Error("Customer name is required.");
  const customerId = id("cust");
  run("INSERT INTO customers VALUES (:id,:company_id,:name,:phone,:created_at)", {
    id: customerId, company_id: companyId(), name: String(name).trim(), phone: String(phone || "").trim() || null, created_at: now()
  });
  audit({ action: "addCustomer", entityType: "customer", entityId: customerId, after: { name, phone }, source: "AI" });
  return { customerId, name: String(name).trim(), phone: String(phone || "").trim() };
}

function deleteCustomer(customerId) {
  const customer = get("SELECT * FROM customers WHERE id = :id", { id: customerId });
  if (!customer) throw new Error("Customer not found.");
  run("DELETE FROM customers WHERE id = :id", { id: customerId });
  audit({ action: "deleteCustomer", entityType: "customer", entityId: customerId, before: customer, source: "AI" });
  return { customerId, name: customer.name, deleted: true };
}

function updateCustomer(customerId, data) {
  const customer = get("SELECT * FROM customers WHERE id = :id", { id: customerId });
  if (!customer) throw new Error("Customer not found.");
  const before = { ...customer };
  const name = String(data.name || customer.name).trim();
  const phone = String(data.phone || customer.phone || "").trim();
  run("UPDATE customers SET name=:name, phone=:phone WHERE id=:id", { name, phone: phone || null, id: customerId });
  audit({ action: "updateCustomer", entityType: "customer", entityId: customerId, before, after: { ...customer, name, phone }, source: "AI" });
  return { customerId, name, phone };
}

function getBusinessSummary() {
  const unitsProduced = get("SELECT COALESCE(SUM(quantity_produced),0) AS v FROM production_entries WHERE created_at >= datetime('now','-7 days')").v;
  const previousUnitsProduced = get("SELECT COALESCE(SUM(quantity_produced),0) AS v FROM production_entries WHERE created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')").v;
  const completedOrders = get("SELECT COUNT(*) AS v FROM orders WHERE status='COMPLETED' AND updated_at >= datetime('now','-7 days')").v;
  const revenue = get("SELECT COALESCE((SELECT SUM(amount) FROM payments WHERE status='CONFIRMED' AND created_at >= datetime('now','-7 days')),0) + COALESCE((SELECT SUM(amount) FROM sales_transactions WHERE created_at >= datetime('now','-7 days')),0) AS v").v;
  const previousRevenue = get("SELECT COALESCE((SELECT SUM(amount) FROM payments WHERE status='CONFIRMED' AND created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')),0) + COALESCE((SELECT SUM(amount) FROM sales_transactions WHERE created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')),0) AS v").v;
  const steelConsumed = get("SELECT COALESCE(SUM(it.quantity),0) AS v FROM inventory_transactions it JOIN inventory i ON i.id=it.inventory_id WHERE i.item_name='Steel' AND it.action='CONSUME' AND it.created_at >= datetime('now','-7 days')").v;
  const previousSteelConsumed = get("SELECT COALESCE(SUM(it.quantity),0) AS v FROM inventory_transactions it JOIN inventory i ON i.id=it.inventory_id WHERE i.item_name='Steel' AND it.action='CONSUME' AND it.created_at >= datetime('now','-14 days') AND it.created_at < datetime('now','-7 days')").v;
  const downtimeMinutes = get("SELECT COALESCE(SUM(CASE WHEN downtime_minutes IS NULL THEN 10 ELSE downtime_minutes END),0) AS v FROM downtime_events").v;
  return {
    unitsProduced: Number(unitsProduced), previousUnitsProduced: Number(previousUnitsProduced), completedOrders: Number(completedOrders), revenue: Number(revenue), previousRevenue: Number(previousRevenue),
    steelConsumed: Number(steelConsumed), previousSteelConsumed: Number(previousSteelConsumed), downtimeHours: (Number(downtimeMinutes) / 60).toFixed(1),
    biggestIssue: Number(downtimeMinutes) > 0 ? "machine downtime" : "low material visibility",
    recommendation: Number(downtimeMinutes) > 0 ? "prioritize Machine 2 repair response and keep critical spares on site." : "set reorder alerts for steel and paint."
  };
}

function dashboard() {
  generateBusinessAlerts(); // Refresh alerts
  
  const jobs = all("SELECT pj.*, u.name AS operator FROM production_jobs pj LEFT JOIN users u ON u.id=pj.operator_id ORDER BY pj.created_at DESC");
  const inventory = all("SELECT * FROM inventory ORDER BY item_type, item_name");
  const machines = all("SELECT m.*, u.name AS technician FROM machines m LEFT JOIN users u ON u.id=m.technician_id ORDER BY m.machine_no");
  const orders = all("SELECT o.*, c.name AS customer, i.invoice_no, i.status AS invoice_status, i.amount FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN invoices i ON i.order_id=o.id ORDER BY o.created_at DESC");
  const alerts = all("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 10");
  const notifications = all("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 20");
  const aiLogs = all("SELECT ac.*, aa.intent, aa.structured_json FROM ai_conversations ac LEFT JOIN ai_actions aa ON aa.conversation_id=ac.id ORDER BY ac.created_at DESC LIMIT 12");
  const tx = all("SELECT it.*, i.item_name, i.unit FROM inventory_transactions it JOIN inventory i ON i.id=it.inventory_id ORDER BY it.created_at DESC LIMIT 20");

  // P&L by period
  const plToday = getProfitAndLoss("today");
  const plWeek = getProfitAndLoss("week");
  const plMonth = getProfitAndLoss("month");

  // Production KPIs
  const productionToday = get("SELECT COALESCE(SUM(quantity_produced),0) AS v FROM production_entries WHERE date(created_at)=date('now')").v;
  const productionWeek = get("SELECT COALESCE(SUM(quantity_produced),0) AS v FROM production_entries WHERE created_at >= datetime('now','-7 days')").v;

  // Debts
  const customerReceivables = getCustomerDebts();
  const totalCustomerDebt = customerReceivables.reduce((sum, d) => sum + Number(d.amount_owed) - Number(d.amount_paid), 0);
  const supplierPayables = getSupplierPayables();
  const totalSupplierDebt = supplierPayables.reduce((sum, d) => sum + Number(d.amount_owed) - Number(d.amount_paid), 0);

  return {
    company: get("SELECT id, name, city FROM companies LIMIT 1"),
    kpis: {
      // Today
      salesToday: plToday.revenue,
      expensesToday: plToday.expenses,
      profitToday: plToday.profit,
      // Week
      salesWeek: plWeek.revenue,
      expensesWeek: plWeek.expenses,
      profitWeek: plWeek.profit,
      profitMarginWeek: plWeek.profitMargin,
      // Month
      salesMonth: plMonth.revenue,
      expensesMonth: plMonth.expenses,
      profitMonth: plMonth.profit,
      // Inventory
      totalProducts: inventory.filter(i => i.item_type !== "RAW_MATERIAL").length,
      lowStockItems: inventory.filter(i => i.item_type === "RAW_MATERIAL" && Number(i.quantity) <= Number(i.reorder_level)).length,
      // Production
      productionToday, productionWeek,
      // Legacy
      ordersToday: get("SELECT COUNT(*) AS v FROM orders WHERE date(created_at)=date('now')").v,
      machinesDown: machines.filter(m => m.status === "DOWN").length,
      outstanding: orders.filter(o => o.invoice_status !== "PAID").reduce((s, o) => s + Number(o.amount || 0), 0),
      customerReceivables: totalCustomerDebt,
      supplierPayables: totalSupplierDebt,
      openAlerts: alerts.filter(a => a.status === "OPEN").length
    },
    financials: {
      today: plToday,
      week: plWeek,
      month: plMonth,
      customerReceivables: totalCustomerDebt,
      supplierPayables: totalSupplierDebt,
      customerDebtList: customerReceivables.slice(0, 10),
      supplierDebtList: supplierPayables.slice(0, 10)
    },
    jobs, inventory, machines, orders, alerts, notifications, aiLogs, inventoryTransactions: tx,
    productionEntries: all("SELECT pe.*, pj.job_no FROM production_entries pe LEFT JOIN production_jobs pj ON pj.id = pe.production_job_id ORDER BY pe.created_at DESC LIMIT 50"),
    sales: all("SELECT * FROM sales_transactions ORDER BY created_at DESC LIMIT 50"),
    purchases: all("SELECT * FROM purchases ORDER BY created_at DESC LIMIT 20"),
    expenses: all("SELECT * FROM expenses ORDER BY created_at DESC LIMIT 20"),
    suppliers: all("SELECT id, name, phone FROM suppliers ORDER BY name"),
    customers: all("SELECT * FROM customers ORDER BY name"),
    customerDebts: customerReceivables.slice(0, 20),
    supplierDebts: supplierPayables.slice(0, 20),
    downtimeEvents: all("SELECT de.*, m.machine_no, m.name AS machine_name, u.name AS technician FROM downtime_events de JOIN machines m ON m.id=de.machine_id LEFT JOIN users u ON u.id=de.technician_id ORDER BY de.created_at DESC"),
    charts: {
      production: all("SELECT substr(created_at,1,10) AS day, SUM(quantity_produced) AS value FROM production_entries GROUP BY day ORDER BY day"),
      consumption: all("SELECT i.item_name AS label, SUM(it.quantity) AS value FROM inventory_transactions it JOIN inventory i ON i.id=it.inventory_id WHERE action='CONSUME' GROUP BY i.item_name"),
      downtime: all("SELECT m.machine_no AS label, COALESCE(SUM(CASE WHEN de.id IS NULL THEN 0 WHEN de.downtime_minutes IS NULL THEN 10 ELSE de.downtime_minutes END),0) AS value FROM machines m LEFT JOIN downtime_events de ON de.machine_id=m.id GROUP BY m.machine_no"),
      revenue: all("SELECT day, SUM(value) AS value FROM (SELECT substr(created_at,1,10) AS day, amount AS value FROM payments WHERE status='CONFIRMED' UNION ALL SELECT substr(created_at,1,10) AS day, amount AS value FROM sales_transactions) GROUP BY day ORDER BY day"),
      expenses: all("SELECT category AS label, SUM(amount) AS value FROM expenses WHERE created_at >= datetime('now','-30 days') GROUP BY category ORDER BY value DESC")
    },
    integrations: getIntegrations(),
    ai: {
      provider: activeAiProvider() === "nvidia" ? "NVIDIA NIM" : activeAiProvider() === "openrouter" ? "OpenRouter" : "Local parser",
      status: activeAiProvider() === "local" ? "CONFIGURATION REQUIRED" : "CONNECTED",
      model: activeAiProvider() === "nvidia" ? nvidiaModel() : process.env.OPENROUTER_MODEL || "openrouter/auto",
      fallbacks: activeAiProvider() === "openrouter" ? openRouterModels().filter((model) => model !== (process.env.OPENROUTER_MODEL || "openrouter/auto")) : []
    },
    users: all("SELECT id, name, phone, role FROM users ORDER BY role")
  };
}

function getIntegrations() {
  const status = (keys) => keys.every((k) => process.env[k]) ? "CONNECTED" : DEMO_MODE ? "SANDBOX MODE" : "CONFIGURATION REQUIRED";
  return [
    { name: "Africa's Talking USSD", status: status(["AFRICASTALKING_USERNAME", "AFRICASTALKING_API_KEY"]), endpoint: "/api/webhooks/africastalking/ussd", mode: process.env.AFRICASTALKING_ENV || "sandbox" },
    { name: "Africa's Talking SMS", status: status(["AFRICASTALKING_USERNAME", "AFRICASTALKING_API_KEY"]), endpoint: "/api/webhooks/africastalking/sms", outbound: `${africasTalkingBase("api")}/version1/messaging`, mode: process.env.AFRICASTALKING_ENV || "sandbox" },
    { name: "Africa's Talking Voice", status: status(["AFRICASTALKING_USERNAME", "AFRICASTALKING_API_KEY", "AFRICASTALKING_VOICE_NUMBER"]), endpoint: "/api/webhooks/africastalking/voice", outbound: `${africasTalkingBase("voice")}/call`, mode: process.env.AFRICASTALKING_ENV || "sandbox" },
    { name: "M-Pesa Daraja", status: status(["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL"]), endpoint: "/api/webhooks/mpesa/callback", outbound: `${darajaBase()}/mpesa/stkpush/v1/processrequest`, mode: process.env.MPESA_ENV || "sandbox" },
    { name: "NVIDIA NIM AI", status: nvidiaConfigured() ? "CONNECTED" : "CONFIGURATION REQUIRED", endpoint: "/api/ai/message", mode: nvidiaModel() },
    { name: "OpenRouter AI", status: openRouterConfigured() ? "CONNECTED" : "CONFIGURATION REQUIRED", endpoint: "/api/ai/message", mode: process.env.OPENROUTER_MODEL || "openrouter/auto" }
  ];
}

function truncateForChannel(text, max = 420) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

// ── USSD AI session helpers ───────────────────────────────────────────────────
// An AI USSD session is active when the caller is inside menu option 8.
// Africa's Talking sends each turn as a fresh request with the full dial string
// (e.g. "*384*8*hello*how are you#") so we detect session continuation by
// checking whether the session map has an entry AND the current input is not a
// top-level single digit that would restart the menu.
function isTopLevelMenuInput(text) {
  return /^\d$/.test(String(text || "").trim());
}

async function ussdResponse(text, phone, sessionId, aiTimeoutMs = Math.max(3_000, USSD_RESPONSE_TIMEOUT_MS - 2_000)) {
  const parts = String(text || "").split("*").filter(Boolean);
  const sessionKey = String(sessionId || phone || "unknown");
  const activeAi = ussdAiSessions.get(sessionKey);

  // Discard stale AI sessions older than 10 minutes
  if (activeAi && Date.now() - activeAi.updatedAt > 10 * 60 * 1000) {
    ussdAiSessions.delete(sessionKey);
  }

  // ── AI session continuation ───────────────────────────────────────────────
  // If the caller is inside an active AI chat session, route every new turn
  // back through the full handleAiMessage pipeline (same as the web app).
  // This gives USSD callers the identical AI capabilities: record sales,
  // purchases, production, expenses, debt payments, answer profit/stock/debt
  // questions — all in English or Swahili.
  if (ussdAiSessions.has(sessionKey) && !isTopLevelMenuInput(text)) {
    // Africa's Talking sends the full accumulated dial string (e.g. "8*hello*how are you").
    // The user's latest message is everything after the first segment ("8").
    const question = parts.slice(1).join("*").trim();
    if (!question) return "CON Biashara AI\nType your message, or 0 to exit:";
    if (question === "0" || /^(exit|quit|back|menu)$/i.test(question)) {
      ussdAiSessions.delete(sessionKey);
      return "END AI session ended. Dial again to return to menu.";
    }

    // Build context from conversation history so AI remembers what was said
    const history = ussdAiSessions.get(sessionKey)?.history || [];
    const contextMsg = history.length
      ? `USSD conversation so far:\n${history.slice(-6).map(t => `User: ${t.q}\nAI: ${t.a}`).join("\n")}\n\nUser: ${question}`
      : question;

    try {
      const result = await handleAiMessage({ message: contextMsg, channel: "USSD", phone, aiTimeoutMs });
      const answer = truncateForChannel(result.response, 280);
      history.push({ q: question, a: answer });
      ussdAiSessions.set(sessionKey, { history, updatedAt: Date.now() });
      return `CON ${answer}\n\nSend another message or 0 to exit.`;
    } catch (err) {
      return `CON Error: ${truncateForChannel(err.message, 160)}\n\nTry again or 0 to exit.`;
    }
  }

  // ── Step-by-step guided menus (options 1, 2, 3, 7) ──────────────────────
  // Stale sessions older than 5 minutes are discarded so the user can restart.
  const activeFlow = ussdSessions.get(sessionKey);
  if (activeFlow && Date.now() - activeFlow.startedAt > 5 * 60 * 1000) {
    ussdSessions.delete(sessionKey);
  } else if (activeFlow && parts[0] === activeFlow.menu) {
    if (parts[1] === "0") {
      ussdSessions.delete(sessionKey);
      return "END Operation cancelled.";
    }
    // ── Menu 1: Record Sale ──
    if (activeFlow.menu === "1") {
      if (parts.length === 2) return "CON Enter quantity sold:";
      if (parts.length === 3) return "CON Enter sale amount (KSh):";
      if (parts.length === 4) return "CON Enter customer name (or 0 to skip):";
      const [, product, qty, amount, customer] = parts;
      ussdSessions.delete(sessionKey);
      try {
        const r = withTransaction(() => createSale({ itemName: product, quantity: Number(qty), amount: Number(amount), customer: customer !== "0" ? customer : null, paymentStatus: "PAID", source: "USSD", userId: null }));
        return `END Sale recorded: ${r.quantity} ${r.unit} of ${r.itemName} for KSh ${Number(r.amount).toLocaleString()}${r.customer ? ` to ${r.customer}` : ""}. Stock: ${r.remaining}.`;
      } catch (err) { return `END Sale error: ${truncateForChannel(err.message, 220)}`; }
    }
    // ── Menu 2: Record Purchase ──
    if (activeFlow.menu === "2") {
      if (parts.length === 2) return "CON Enter quantity purchased:";
      if (parts.length === 3) return "CON Enter total cost (KSh):";
      if (parts.length === 4) return "CON Enter supplier name (or 0 to skip):";
      const [, item, qty, cost, supplier] = parts;
      ussdSessions.delete(sessionKey);
      try {
        const r = withTransaction(() => recordPurchase({ itemName: item, quantity: Number(qty), totalCost: Number(cost), supplierName: supplier !== "0" ? supplier : null, paymentStatus: "PAID", source: "USSD" }));
        return `END Purchase recorded: ${r.quantity} ${r.unit} of ${r.itemName} for KSh ${Number(r.totalCost).toLocaleString()}${r.supplier ? ` from ${r.supplier}` : ""}.`;
      } catch (err) { return `END Purchase error: ${truncateForChannel(err.message, 220)}`; }
    }
    // ── Menu 3: Record Production ──
    if (activeFlow.menu === "3") {
      if (parts.length === 2) return "CON Enter quantity produced:";
      if (parts.length === 3) return "CON Enter material used (e.g. Steel):";
      if (parts.length === 4) return "CON Enter material quantity used:";
      const [, product, quantity, material, materialQuantity] = parts;
      ussdSessions.delete(sessionKey);
      try {
        const r = withTransaction(() => createProductionEntry({ productName: product, quantityProduced: Number(quantity), materialName: material, quantityConsumed: Number(materialQuantity), unit: "kg", source: "USSD", userId: null }));
        return `END Production recorded: ${r.quantityProduced} units of ${r.product}.`;
      } catch (err) { return `END Production error: ${truncateForChannel(err.message, 220)}`; }
    }
    // ── Menu 7: Record Expense ──
    if (activeFlow.menu === "7") {
      if (parts.length === 2) return "CON Enter amount (KSh):";
      if (parts.length === 3) return "CON Enter description (or 0 to skip):";
      const catMap = { "1": "RENT", "2": "TRANSPORT", "3": "FUEL", "4": "ELECTRICITY", "5": "WAGES", "6": "OTHER" };
      const category = catMap[parts[1]] || parts[1].toUpperCase();
      const amount = Number(parts[2]);
      const description = parts[3] && parts[3] !== "0" ? parts[3] : "";
      ussdSessions.delete(sessionKey);
      if (!amount || amount <= 0) return "END Invalid amount. Please try again.";
      try {
        withTransaction(() => recordExpense({ category, description, amount, source: "USSD" }));
        return `END Expense recorded: KSh ${amount.toLocaleString()} for ${category.toLowerCase()}${description ? ` (${description})` : ""}.`;
      } catch (err) { return `END Expense error: ${truncateForChannel(err.message, 220)}`; }
    }
  }

  // ── Main menu ─────────────────────────────────────────────────────────────
  if (parts.length === 0) {
    return "CON Biashara OS\n1. Record Sale\n2. Record Purchase\n3. Record Production\n4. Check Stock\n5. Check Debts\n6. Business Summary\n7. Record Expense\n8. Biashara AI\n0. Exit";
  }

  // ── Option 1: Record Sale (guided) ────────────────────────────────────────
  if (parts[0] === "1") {
    ussdSessions.set(sessionKey, { menu: "1", startedAt: Date.now() });
    if (parts.length === 1) return "CON Record Sale\nEnter product name (e.g. Steel Gate):";
    if (parts.length === 2) return "CON Enter quantity sold:";
    if (parts.length === 3) return "CON Enter sale amount (KSh):";
    if (parts.length === 4) return "CON Enter customer name (or 0 to skip):";
    const [, product, qty, amount, customer] = parts;
    ussdSessions.delete(sessionKey);
    try {
      const r = withTransaction(() => createSale({ itemName: product, quantity: Number(qty), amount: Number(amount), customer: customer !== "0" ? customer : null, paymentStatus: "PAID", source: "USSD", userId: null }));
      return `END Sale recorded: ${r.quantity} ${r.unit} of ${r.itemName} for KSh ${Number(r.amount).toLocaleString()}${r.customer ? ` to ${r.customer}` : ""}. Stock: ${r.remaining}.`;
    } catch (err) { return `END Sale error: ${truncateForChannel(err.message, 220)}`; }
  }

  // ── Option 2: Record Purchase (guided) ────────────────────────────────────
  if (parts[0] === "2") {
    ussdSessions.set(sessionKey, { menu: "2", startedAt: Date.now() });
    if (parts.length === 1) return "CON Record Purchase\nEnter item name (e.g. Steel):";
    if (parts.length === 2) return "CON Enter quantity purchased:";
    if (parts.length === 3) return "CON Enter total cost (KSh):";
    if (parts.length === 4) return "CON Enter supplier name (or 0 to skip):";
    const [, item, qty, cost, supplier] = parts;
    ussdSessions.delete(sessionKey);
    try {
      const r = withTransaction(() => recordPurchase({ itemName: item, quantity: Number(qty), totalCost: Number(cost), supplierName: supplier !== "0" ? supplier : null, paymentStatus: "PAID", source: "USSD" }));
      return `END Purchase recorded: ${r.quantity} ${r.unit} of ${r.itemName} for KSh ${Number(r.totalCost).toLocaleString()}${r.supplier ? ` from ${r.supplier}` : ""}.`;
    } catch (err) { return `END Purchase error: ${truncateForChannel(err.message, 220)}`; }
  }

  // ── Option 3: Record Production (guided) ──────────────────────────────────
  if (parts[0] === "3") {
    ussdSessions.set(sessionKey, { menu: "3", startedAt: Date.now() });
    if (parts.length === 1) return "CON Record Production\nEnter product name (e.g. Steel Gate):";
    if (parts.length === 2) return "CON Enter quantity produced:";
    if (parts.length === 3) return "CON Enter material used (e.g. Steel):";
    if (parts.length === 4) return "CON Enter material quantity used:";
    const [, product, quantity, material, materialQuantity] = parts;
    ussdSessions.delete(sessionKey);
    try {
      const r = withTransaction(() => createProductionEntry({ productName: product, quantityProduced: Number(quantity), materialName: material, quantityConsumed: Number(materialQuantity), unit: "kg", source: "USSD", userId: null }));
      return `END Production recorded: ${r.quantityProduced} units of ${r.product}.`;
    } catch (err) { return `END Production error: ${truncateForChannel(err.message, 220)}`; }
  }

  // ── Option 4: Check Stock ─────────────────────────────────────────────────
  if (parts[0] === "4") {
    const inv = all("SELECT item_name, quantity, unit, reorder_level FROM inventory ORDER BY item_type, item_name")
      .map(i => `${i.item_name}: ${i.quantity}${i.unit}${Number(i.quantity) <= Number(i.reorder_level) ? " *LOW*" : ""}`)
      .join("\n");
    return `END Stock\n${inv || "No stock records yet."}`;
  }

  // ── Option 5: Check Debts ─────────────────────────────────────────────────
  if (parts[0] === "5") {
    const debts = getCustomerDebts();
    const total = debts.reduce((s, d) => s + Number(d.amount_owed) - Number(d.amount_paid), 0);
    const payables = getSupplierPayables();
    const payTotal = payables.reduce((s, d) => s + Number(d.amount_owed) - Number(d.amount_paid), 0);
    const debtLines = debts.slice(0, 3).map(d => `${d.customer_name}: KSh ${(Number(d.amount_owed) - Number(d.amount_paid)).toLocaleString()}`).join("\n");
    return `END Debts\nOwed to you: KSh ${total.toLocaleString()}\n${debtLines || "None"}\nYou owe: KSh ${payTotal.toLocaleString()}`;
  }

  // ── Option 6: Business Summary ────────────────────────────────────────────
  if (parts[0] === "6") {
    const pl = getProfitAndLoss("week");
    const pt = get("SELECT COALESCE(SUM(quantity_produced),0) AS v FROM production_entries WHERE created_at >= datetime('now','-7 days')").v;
    return `END This Week\nRevenue: KSh ${pl.revenue.toLocaleString()}\nExpenses: KSh ${pl.expenses.toLocaleString()}\nProfit: KSh ${pl.profit.toLocaleString()}\nMargin: ${pl.profitMargin}%\nProduced: ${pt} units`;
  }

  // ── Option 7: Record Expense (guided) ─────────────────────────────────────
  if (parts[0] === "7") {
    ussdSessions.set(sessionKey, { menu: "7", startedAt: Date.now() });
    if (parts.length === 1) {
      return "CON Record Expense\nEnter category:\n1.Rent 2.Transport 3.Fuel\n4.Electricity 5.Wages 6.Other";
    }
    if (parts.length === 2) return "CON Enter amount (KSh):";
    if (parts.length === 3) return "CON Enter description (or 0 to skip):";
    const catMap = { "1": "RENT", "2": "TRANSPORT", "3": "FUEL", "4": "ELECTRICITY", "5": "WAGES", "6": "OTHER" };
    const category = catMap[parts[1]] || parts[1].toUpperCase();
    const amount = Number(parts[2]);
    const description = parts[3] && parts[3] !== "0" ? parts[3] : "";
    ussdSessions.delete(sessionKey);
    if (!amount || amount <= 0) return "END Invalid amount. Please try again.";
    try {
      withTransaction(() => recordExpense({ category, description, amount, source: "USSD" }));
      return `END Expense recorded: KSh ${amount.toLocaleString()} for ${category.toLowerCase()}${description ? ` (${description})` : ""}.`;
    } catch (err) { return `END Expense error: ${truncateForChannel(err.message, 220)}`; }
  }

  // ── Option 8: Biashara AI (full natural-language chat) ────────────────────
  // Same capabilities as the web app: record sales, purchases, production,
  // expenses, debt payments, answer profit/stock/debt questions in English
  // or Swahili. Multi-turn conversation is maintained across USSD turns.
  if (parts[0] === "8") {
    if (parts.length === 1) {
      // Start AI session
      ussdAiSessions.set(sessionKey, { history: [], updatedAt: Date.now() });
      return "CON Biashara AI\nTalk to your business in English or Swahili.\nExamples:\n- Nimeuza milango 3 kwa 45000\n- How much profit this week?\n- John alinilipa 10000\n\nType message or 0 to exit:";
    }
    // Subsequent turns in the same dial string (e.g. *384*8*message#)
    const question = parts.slice(1).join("*");
    const history = ussdAiSessions.get(sessionKey)?.history || [];
    const contextMsg = history.length
      ? `USSD conversation so far:\n${history.slice(-6).map(t => `User: ${t.q}\nAI: ${t.a}`).join("\n")}\n\nUser: ${question}`
      : question;
    try {
      const result = await handleAiMessage({ message: contextMsg, channel: "USSD", phone, aiTimeoutMs });
      const answer = truncateForChannel(result.response, 280);
      history.push({ q: question, a: answer });
      ussdAiSessions.set(sessionKey, { history, updatedAt: Date.now() });
      return `CON ${answer}\n\nSend another message or 0 to exit.`;
    } catch (err) {
      return `CON Error: ${truncateForChannel(err.message, 160)}\n\nTry again or 0 to exit.`;
    }
  }

  if (parts[0] === "0") return "END Thank you for using Biashara OS. Goodbye!";
  return "END Invalid option. Dial again and choose 1-8.";
}

function xmlEscape(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  }[char]));
}

function voiceXml(lines) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${lines.join("")}</Response>`;
}

function say(text) {
  return `<Say>${xmlEscape(text)}</Say>`;
}

async function voiceResponse(data) {
  const phone = data.callerNumber || data.from || data.phoneNumber || "+254700000005";
  const digit = data.dtmfDigits || data.digits || data.Digits;
  const speech = data.speechText || data.speech || data.text || data.message || data.transcript;

  if (speech && !/^\d+$/.test(String(speech).trim())) {
    const result = await handleAiMessage({ message: speech, channel: "VOICE", phone });
    return voiceXml([say(truncateForChannel(result.response, 520))]);
  }

  if (digit === "1") {
    const result = await handleAiMessage({ message: "Give me a short business summary for this week.", channel: "VOICE", phone });
    return voiceXml([say(truncateForChannel(result.response, 520))]);
  }

  if (digit === "2") {
    return voiceXml([
      say("To chat with Biashara AI by voice, send a speech transcript field to this webhook. For keypad phones, use USSD option 5 and type your question.")
    ]);
  }

  return voiceXml([
    say("Welcome to Biashara OS. Press 1 for an AI business summary. Press 2 for AI chat instructions."),
    `<GetDigits timeout="10" numDigits="1">${say("Enter your option now.")}</GetDigits>`,
    say("No option received. Goodbye.")
  ]);
}

function verifyWebhook(req, body) {
  const secret = process.env.WEBHOOK_SHARED_SECRET;
  if (!secret || DEMO_MODE) return true;
  const sig = req.headers["x-biashara-signature"];
  if (!sig) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const rate = new Map();
function rateLimit(req) {
  const ip = clientIpOf(req);
  const bucket = rate.get(ip) || { count: 0, reset: Date.now() + 60000 };
  if (bucket.reset < Date.now()) Object.assign(bucket, { count: 0, reset: Date.now() + 60000 });
  bucket.count += 1;
  rate.set(ip, bucket);
  return bucket.count <= 120;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      const type = req.headers["content-type"] || "";
      if (type.includes("application/json")) return resolve({ raw: body, data: body ? JSON.parse(body) : {} });
      if (type.includes("application/x-www-form-urlencoded")) return resolve({ raw: body, data: Object.fromEntries(new URLSearchParams(body)) });
      resolve({ raw: body, data: body ? JSON.parse(body) : {} });
    });
  });
}

function json(res, status, data, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  const path = new URL(req.url, `http://${req.headers.host}`).pathname;
  const file = path === "/" ? join(PUBLIC, "index.html") : join(PUBLIC, decodeURIComponent(path));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "Forbidden" });
  try {
    const contents = readFileSync(file);
    const ext = extname(file);
    const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(contents);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function route(req, res) {
  let account = null;
  let store = mainDb;
  try {
    account = auth.currentAccount(req);
    store = dbForAccount(account);
  } catch (err) {
    console.error("Workspace lookup failed:", err.message);
    return json(res, 500, { error: "Could not open your workspace" });
  }
  try {
    return await tenantContext.run(store, () => handleRequest(req, res, account));
  } finally {
    // Any write may have changed this workspace and, for sign-ins, the shared
    // accounts/sessions tables, so queue both for backup.
    if (req.method !== "GET" && req.method !== "HEAD") {
      markForBackup(mainDb);
      markForBackup(store);
    }
  }
}

function markForBackup(store) {
  if (backupPaths.has(store)) cloud.markDirty(backupPaths.get(store), store);
}

// Creates a brand-new account's workspace and queues it for backup.
function provisionWorkspace(account) {
  const store = tenantDb(account.tenant);
  tenantContext.run(store, () => createStarterCompany(account.name));
  markForBackup(store);
}

async function handleRequest(req, res, account) {
  try {
    if (!rateLimit(req)) return json(res, 429, { error: "Rate limit exceeded" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/api/")) {
      // The dashboard itself needs a signed-in account; assets and the sign-in page do not.
      const isDashboard = url.pathname === "/" || url.pathname === "/index.html";
      if (isDashboard && !account) {
        res.writeHead(302, { location: "/login.html", "cache-control": "no-store" });
        return res.end();
      }
      if (url.pathname === "/login.html" && account) {
        res.writeHead(302, { location: "/", "cache-control": "no-store" });
        return res.end();
      }
      return serveStatic(req, res);
    }
    if (url.pathname.startsWith("/api/auth/")) return authRoute(req, res, url, account);
    // Webhooks are called by Africa's Talking / M-Pesa, not a browser, so they skip sign-in.
    if (!account && !url.pathname.startsWith("/api/webhooks/")) return json(res, 401, { error: "Sign in required" });
    if (req.method === "GET" && (url.pathname === "/api/dashboard" || url.pathname === "/api/dashboard/summary")) return json(res, 200, dashboard());
    if (req.method === "GET" && url.pathname === "/api/schema") return json(res, 200, { schema: readFileSync(join(ROOT, "supabase-schema.sql"), "utf8") });
    const { raw, data } = await parseBody(req);
    // Africa's Talking webhooks (USSD, SMS, Voice) do not send x-biashara-signature,
    // so skip the signature check for AT paths and only apply it to non-AT webhooks.
    const isAtWebhook = url.pathname.startsWith("/api/webhooks/africastalking/");
    if (url.pathname.includes("/webhooks/") && !isAtWebhook && !verifyWebhook(req, raw)) return json(res, 401, { error: "Invalid webhook signature" });
    if (req.method === "POST" && url.pathname === "/api/ai/message") {
      if (!takeAiAllowance()) return json(res, 429, { error: AI_LIMIT_MESSAGE });
      return json(res, 200, await handleAiMessage(data));
    }
    if (req.method === "POST" && url.pathname === "/api/ai/test") return json(res, 200, await testAiProvider());
    if (req.method === "POST" && url.pathname === "/api/webhooks/africastalking/sms") {
      const result = await handleAiMessage({ message: data.text || data.message, channel: "SMS", phone: data.from || data.phoneNumber || "+254700000004" });
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/africastalking/ussd") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      let response;
      try {
        response = await Promise.race([
          ussdResponse(data.text, data.phoneNumber || data.from || "+254700000004", data.sessionId),
          new Promise((resolve) => setTimeout(() => resolve("CON Request timed out. Please try again or 0 to exit."), USSD_RESPONSE_TIMEOUT_MS))
        ]);
      } catch (err) {
        response = "END Service error. Please try again later.";
      }
      return res.end(response);
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/africastalking/voice") {
      res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" });
      return res.end(await voiceResponse(data));
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/mpesa/callback") {
      return json(res, 200, recordPayment({ invoiceId: data.invoiceId, amount: data.amount, reference: data.reference, rawPayload: data }));
    }
    if (req.method === "POST" && url.pathname === "/api/mpesa/stk-push") {
      return json(res, 200, await initiateStkPush(data));
    }
    if (req.method === "POST" && url.pathname === "/api/mpesa/test-credentials") {
      await darajaToken();
      return json(res, 200, { ok: true, message: "Daraja credentials authenticated successfully", environment: process.env.MPESA_ENV || "sandbox" });
    }
    if (req.method === "POST" && url.pathname === "/api/setup") return json(res, 201, setupWorkspace(data));
    if (req.method === "POST" && url.pathname === "/api/integrations/test") {
      if (data.channel === "SMS") return json(res, 200, { notificationId: sendNotification({ channel: "SMS", recipient: data.to || "+254700000004", message: "Biashara OS Africa's Talking sandbox SMS test.", provider: "africastalking" }) });
      if (data.channel === "VOICE") return json(res, 200, { notificationId: sendNotification({ channel: "VOICE", recipient: data.to || "+254700000005", message: "Biashara OS voice escalation test.", provider: "africastalking" }) });
      if (data.channel === "MPESA") {
        const invoice = get("SELECT id, amount FROM invoices WHERE status='UNPAID' ORDER BY issued_at DESC LIMIT 1");
        return json(res, 200, await initiateStkPush({ phone: data.phone || "254708374149", amount: invoice?.amount || 1, invoiceId: invoice?.id || "demo-invoice" }));
      }
      return json(res, 400, { error: "Use channel SMS, VOICE, or MPESA" });
    }
    // ========== SALES ENDPOINTS ==========
    if (req.method === "POST" && url.pathname === "/api/sales") {
      return json(res, 201, withTransaction(() => createSale({
        itemName: data.product, quantity: Number(data.quantity), unit: data.unit, amount: Number(data.amount),
        customer: data.customer, paymentStatus: data.paymentStatus, source: "WEB"
      })));
    }
    if (req.method === "GET" && url.pathname === "/api/sales") {
      return json(res, 200, all("SELECT * FROM sales_transactions ORDER BY created_at DESC LIMIT 50"));
    }
    // ========== PURCHASES ENDPOINTS ==========
    if (req.method === "POST" && url.pathname === "/api/purchases") {
      return json(res, 201, withTransaction(() => recordPurchase({
        supplierName: data.supplier, itemName: data.item, quantity: Number(data.quantity), unit: data.unit,
        totalCost: Number(data.totalCost), paymentStatus: data.paymentStatus, source: "WEB"
      })));
    }
    if (req.method === "GET" && url.pathname === "/api/purchases") {
      return json(res, 200, listPurchases());
    }
    // ========== PRODUCTION ENDPOINTS ==========
    if (req.method === "GET" && url.pathname === "/api/production") {
      return json(res, 200, all("SELECT pe.*, pj.job_no FROM production_entries pe LEFT JOIN production_jobs pj ON pj.id = pe.production_job_id ORDER BY pe.created_at DESC LIMIT 50"));
    }
    if (req.method === "POST" && url.pathname === "/api/production") {
      const user = findUserByPhone(data.phone || "+254700000001");
      return json(res, 201, withTransaction(() => createProductionEntry({
        productName: data.product, quantityProduced: Number(data.quantity), materialName: data.material,
        quantityConsumed: Number(data.materialQuantity || 0), unit: data.unit || "kg", source: "WEB", userId: user?.id
      })));
    }
    // ========== CUSTOMER ENDPOINTS ==========
    if (req.method === "POST" && url.pathname === "/api/customers") {
      if (!companyId()) return json(res, 400, { error: "Configure the workspace first." });
      if (!String(data.name || "").trim()) return json(res, 400, { error: "Customer name is required." });
      return json(res, 201, withTransaction(() => addCustomerExplicit({ name: data.name, phone: data.phone })));
    }
    if (req.method === "GET" && url.pathname === "/api/customers") {
      return json(res, 200, all("SELECT * FROM customers ORDER BY name"));
    }
    // ========== ORDER CREATE BY NAME ENDPOINT ==========
    if (req.method === "POST" && url.pathname === "/api/orders") {
      if (!companyId()) return json(res, 400, { error: "Configure the workspace first." });
      const customerName = String(data.customer || "").trim();
      const productName = String(data.product || "").trim();
      const qty = Number(data.quantity || 1);
      if (!customerName || !productName || qty <= 0) return json(res, 400, { error: "Customer, product, and quantity are required." });
      let cust = findCustomer(customerName);
      if (!cust) {
        const added = withTransaction(() => addCustomerExplicit({ name: customerName }));
        cust = get("SELECT * FROM customers WHERE id=:id", { id: added.customerId });
      }
      const product = findProduct(productName);
      if (!product) return json(res, 400, { error: `Product "${productName}" not found. Add it in Setup first.` });
      return json(res, 201, withTransaction(() => createOrder({ customerId: cust.id, productId: product.id, quantity: qty, source: "WEB" })));
    }
    // ========== INVENTORY CONFIGURE ENDPOINT ==========
    if (req.method === "POST" && url.pathname === "/api/inventory") {
      if (!companyId()) return json(res, 400, { error: "Configure the workspace first." });
      return json(res, 201, withTransaction(() => configureRecord({
        target: data.type === "product" ? "product" : "material",
        name: data.name, unit: data.unit, quantity: Number(data.quantity || 0),
        reorderLevel: Number(data.reorderLevel || 0), supplier: data.supplier || "",
        source: "WEB"
      })));
    }
    // ========== SUPPLIER ENDPOINTS ==========
    if (req.method === "POST" && url.pathname === "/api/suppliers") return json(res, 201, withTransaction(() => addSupplier(data)));
    if (req.method === "GET" && url.pathname === "/api/suppliers") return json(res, 200, listSuppliers());
    if (req.method === "PUT" && url.pathname.startsWith("/api/suppliers/")) {
      const id = url.pathname.split("/")[3];
      return json(res, 200, withTransaction(() => updateSupplier(id, data)));
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/suppliers/")) {
      const id = url.pathname.split("/")[3];
      return json(res, 200, withTransaction(() => deleteSupplier(id)));
    }
    // ========== EXPENSE ENDPOINTS ==========
    if (req.method === "POST" && url.pathname === "/api/expenses") return json(res, 201, withTransaction(() => recordExpense(data)));
    if (req.method === "GET" && url.pathname === "/api/expenses") {
      const period = new URL(req.url, `http://${req.headers.host}`).searchParams.get("period") || "all";
      return json(res, 200, listExpenses(period));
    }
    // ========== PROFIT & LOSS ENDPOINTS ==========
    if (req.method === "GET" && url.pathname === "/api/reports/profit-loss") {
      const period = new URL(req.url, `http://${req.headers.host}`).searchParams.get("period") || "week";
      return json(res, 200, getProfitAndLoss(period));
    }
    // ========== CUSTOMER DEBT ENDPOINTS ==========
    if (req.method === "POST" && url.pathname === "/api/debts/customer") return json(res, 201, withTransaction(() => createCustomerDebt(data)));
    if (req.method === "GET" && url.pathname === "/api/debts/customer") return json(res, 200, getCustomerDebts());
    if (req.method === "POST" && url.pathname === "/api/debts/customer/payment") {
      // Accept either debtId (legacy) or customer name
      if (data.debtId) return json(res, 201, withTransaction(() => recordDebtPayment({ debtId: data.debtId, amount: Number(data.amount), paymentMethod: data.method || "CASH" })));
      const cust = data.customer ? findCustomer(data.customer) : null;
      if (!cust) return json(res, 400, { error: "Customer not found. Provide customer name or debtId." });
      const debt = get("SELECT * FROM customer_debts WHERE customer_id=:cid AND status IN ('UNPAID','PARTIAL') ORDER BY created_at DESC LIMIT 1", { cid: cust.id });
      if (!debt) return json(res, 400, { error: `No outstanding debt found for ${cust.name}.` });
      return json(res, 201, withTransaction(() => recordDebtPayment({ debtId: debt.id, amount: Number(data.amount), paymentMethod: data.method || "CASH" })));
    }
    // ========== SUPPLIER DEBT ENDPOINTS ==========
    if (req.method === "POST" && url.pathname === "/api/debts/supplier") return json(res, 201, withTransaction(() => createSupplierDebt(data)));
    if (req.method === "GET" && url.pathname === "/api/debts/supplier") return json(res, 200, getSupplierPayables());
    if (req.method === "POST" && url.pathname === "/api/debts/supplier/payment") {
      if (data.debtId) return json(res, 201, withTransaction(() => recordSupplierPayment({ debtId: data.debtId, amount: Number(data.amount), paymentMethod: data.method || "CASH" })));
      const sup = data.supplier ? findSupplier(data.supplier) : null;
      if (!sup) return json(res, 400, { error: "Supplier not found. Provide supplier name or debtId." });
      const debt = get("SELECT * FROM supplier_debts WHERE supplier_id=:sid AND status IN ('UNPAID','PARTIAL') ORDER BY created_at DESC LIMIT 1", { sid: sup.id });
      if (!debt) return json(res, 400, { error: `No outstanding payable found for ${sup.name}.` });
      return json(res, 201, withTransaction(() => recordSupplierPayment({ debtId: debt.id, amount: Number(data.amount), paymentMethod: data.method || "CASH" })));
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/order") {
      const cust = get("SELECT * FROM customers WHERE name LIKE 'ABC%' LIMIT 1");
      return json(res, 200, createOrder({ customerId: cust.id, productId: "prod_door", quantity: 3, source: "demo" }));
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/reset") {
      return json(res, 200, resetDemoData());
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/sms") {
      return json(res, 200, await handleAiMessage({ message: data.message || "Nimetumia chuma kilo 20 kutengeneza milango mitatu", channel: "SMS", phone: "+254700000004" }));
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/low-stock") {
      return json(res, 200, consumeInventory({ itemName: "Steel", quantity: 5, source: "DEMO", userId: "usr_store", note: "Demo low stock trigger" }));
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/downtime") {
      return json(res, 200, await handleAiMessage({ message: "Machine 2 imeharibika", channel: "SMS", phone: "+254700000004" }));
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/escalate") {
      const event = get("SELECT id FROM downtime_events WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 1");
      return json(res, 200, event ? escalateDowntime(event.id) : { skipped: true });
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/resolve") {
      const event = get("SELECT id FROM downtime_events WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 1");
      return json(res, 200, event ? resolveMaintenance(event.id, "usr_tech") : { skipped: true });
    }
    if (DEMO_MODE && req.method === "POST" && url.pathname === "/api/demo/mpesa") {
      const invoice = get("SELECT id, amount FROM invoices WHERE status='UNPAID' ORDER BY issued_at DESC LIMIT 1");
      return json(res, 200, recordPayment({ invoiceId: invoice?.id, amount: invoice?.amount, reference: `SANDBOX-${Date.now()}`, rawPayload: data }));
    }
    // ========== JUA KALI: CASHBOOK ==========
    if (req.method === "GET" && url.pathname === "/api/cashbook") {
      return json(res, 200, getDailyCashbook(url.searchParams.get("date")));
    }
    // ========== JUA KALI: PRICING ==========
    if (req.method === "POST" && url.pathname === "/api/pricing/suggest") {
      return json(res, 200, suggestPrice(data || {}));
    }
    // ========== JUA KALI: CHAMA ==========
    if (req.method === "GET" && url.pathname === "/api/chama/members") {
      return json(res, 200, listChamaMembers());
    }
    if (req.method === "POST" && url.pathname === "/api/chama/members") {
      return json(res, 201, withTransaction(() => addChamaMember({ name: data.name, phone: data.phone, role: data.role, source: "WEB" })));
    }
    if (req.method === "POST" && url.pathname === "/api/chama/contribute") {
      return json(res, 201, withTransaction(() => logChamaContribution({ member: data.member, amount: Number(data.amount), kind: data.kind, note: data.note, source: "WEB" })));
    }
    if (req.method === "GET" && url.pathname === "/api/chama/balance") {
      return json(res, 200, getChamaBalance(url.searchParams.get("member")));
    }
    // ========== JUA KALI: PIECEWORK ==========
    if (req.method === "GET" && url.pathname === "/api/piecework") {
      return json(res, 200, getPendingPiecework(url.searchParams.get("worker")));
    }
    if (req.method === "POST" && url.pathname === "/api/piecework") {
      return json(res, 201, withTransaction(() => recordPiecework({ worker: data.worker, job: data.job, units: Number(data.units), rate: Number(data.rate), source: "WEB" })));
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/piecework/") && url.pathname.endsWith("/pay")) {
      const pid = url.pathname.split("/")[3];
      return json(res, 200, withTransaction(() => markPieceworkPaid(pid, null, "WEB")));
    }
    // ========== PROACTIVE AI ==========
    if (req.method === "GET" && url.pathname === "/api/ai/daily-summary") {
      return json(res, 200, generateDailySummary(url.searchParams.get("language") || "Swahili"));
    }
    if (req.method === "POST" && url.pathname === "/api/ai/daily-summary/send") {
      const summary = generateDailySummary(data.language || "Swahili");
      if (summary.error) return json(res, 400, summary);
      // Send to the business owner (and any phone list the caller supplies).
      const owner = get("SELECT phone FROM users WHERE role='OWNER' LIMIT 1");
      const recipients = Array.isArray(data.recipients) && data.recipients.length ? data.recipients : (owner ? [owner.phone] : []);
      const sent = [];
      for (const r of recipients) {
        try { sendNotification({ channel: "SMS", recipient: r, message: summary.text, provider: "africastalking" }); sent.push(r); }
        catch (e) { console.error("daily-summary send failed:", r, e.message); }
      }
      return json(res, 200, { ...summary, sent_to: sent });
    }
    if (req.method === "GET" && url.pathname === "/api/ai/alerts") {
      return json(res, 200, {
        dormant_customers: getDormantCustomers(Number(url.searchParams.get("days")) || 21),
        pricing_anomalies: getPricingAnomalies(),
        daily_cashbook: getDailyCashbook()
      });
    }
    // ========== RECEIPT OCR ==========
    if (req.method === "POST" && url.pathname === "/api/ai/receipt") {
      if (!takeAiAllowance()) return json(res, 429, { error: AI_LIMIT_MESSAGE });
      const result = await extractReceiptFromImage(data);
      return json(res, result?.error ? 400 : 200, result);
    }
    return json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.end();
    return json(res, 500, { error: err.message });
  }
}

// Behind Render's proxy every request comes from the proxy's address, so with
// TRUST_PROXY=true the visitor's IP is read from True-Client-Ip, which the
// Cloudflare layer in front of Render sets. X-Forwarded-For is not used: Render
// appends to it, so a client could forge the first entry.
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
function clientIpOf(req) {
  if (TRUST_PROXY) {
    const trusted = String(req.headers["true-client-ip"] || req.headers["cf-connecting-ip"] || "").trim();
    if (trusted) return trusted;
  }
  return req.socket.remoteAddress || "local";
}

async function authRoute(req, res, url, account) {
  const clientIp = clientIpOf(req);
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const publicAccount = account ? { id: account.id, email: account.email, name: account.name } : null;
    return json(res, 200, { authenticated: Boolean(account), account: publicAccount, needsSetup: auth.accountCount() === 0 });
  }
  if (req.method === "GET" && url.pathname === "/api/auth/config") {
    return json(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null, emailCodes: EMAIL_CODES_ENABLED });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/email/request") {
    let email = "";
    try {
      if (!EMAIL_CODES_ENABLED) throw Object.assign(new Error("Email sign-in is not configured"), { status: 503 });
      const { data } = await parseBody(req);
      if (!auth.accountExists(data.email)) {
        return json(res, 404, { error: "No account found for this email. Create an account first.", needsSignup: true });
      }
      const created = auth.createEmailCode(data.email, clientIp);
      email = created.email;
      await sendLoginCodeEmail(created.email, created.code);
      return json(res, 200, { ok: true });
    } catch (err) {
      // A code that was never delivered must not block a retry for a minute.
      if (email && !err.status) auth.discardEmailCode(email);
      if (!err.status) console.error("Login code email failed:", err.message);
      return json(res, err.status || 502, { error: err.status ? err.message : "Could not send the code. Try again." });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/auth/signup") {
    let email = "";
    try {
      if (!EMAIL_CODES_ENABLED) throw Object.assign(new Error("Sign-up is not available right now"), { status: 503 });
      const { data } = await parseBody(req);
      const created = auth.startSignup(data, clientIp);
      email = created.email;
      await sendLoginCodeEmail(created.email, created.code);
      return json(res, 200, { codeSent: true, email: created.email });
    } catch (err) {
      if (email && !err.status) auth.discardEmailCode(email);
      if (!err.status) console.error("Sign-up code email failed:", err.message);
      return json(res, err.status || 502, { error: err.status ? err.message : "Could not send the code. Try again." });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/auth/email/verify") {
    try {
      const { data } = await parseBody(req);
      const result = auth.verifyEmailCode(data.email, data.code, clientIp);
      if (result.isNew) provisionWorkspace(result.account);
      const { id: accountId, email, name } = result.account;
      return json(res, 200, { account: { id: accountId, email, name } }, { "set-cookie": auth.sessionCookie(req, result.token) });
    } catch (err) {
      return json(res, err.status || 400, { error: err.status ? err.message : "Invalid request" });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/auth/google") {
    try {
      const { data } = await parseBody(req);
      const claims = await verifyGoogleIdToken(data.credential);
      // No account for this Google email yet: send them to sign-up instead.
      if (!auth.accountExists(claims.email)) {
        return json(res, 200, { needsSignup: true, email: String(claims.email).toLowerCase(), name: String(claims.name || "").slice(0, 120) });
      }
      // When email can be sent, Google sign-in also needs the emailed code:
      // send it here and let the browser finish through /api/auth/email/verify.
      if (EMAIL_CODES_ENABLED) {
        const created = auth.createEmailCode(claims.email, clientIp, { name: claims.name, reuseRecent: true });
        if (created.code) {
          try {
            await sendLoginCodeEmail(created.email, created.code);
          } catch (sendErr) {
            auth.discardEmailCode(created.email);
            console.error("Login code email failed:", sendErr.message);
            return json(res, 502, { error: "Could not send the code. Try again." });
          }
        }
        return json(res, 200, { codeSent: true, email: created.email });
      }
      const result = auth.googleLogin(claims, clientIp);
      if (result.isNew) provisionWorkspace(result.account);
      const { id: accountId, email, name } = result.account;
      return json(res, 200, { account: { id: accountId, email, name } }, { "set-cookie": auth.sessionCookie(req, result.token) });
    } catch (err) {
      return json(res, err.status || 400, { error: err.status ? err.message : "Google sign-in failed" });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    auth.logout(req);
    return json(res, 200, { ok: true }, { "set-cookie": auth.sessionCookie(req, "") });
  }
  if (req.method !== "POST" || !["/api/auth/login", "/api/auth/register"].includes(url.pathname)) {
    return json(res, 404, { error: "Not found" });
  }
  try {
    const { data } = await parseBody(req);
    const result = url.pathname === "/api/auth/login" ? auth.login(data, clientIp) : auth.registerFirstAccount(data);
    return json(res, 200, { account: result.account }, { "set-cookie": auth.sessionCookie(req, result.token) });
  } catch (err) {
    return json(res, err.status || 400, { error: err.status ? err.message : "Invalid request" });
  }
}

migrate();
const auth = createAuth(mainDb);
if (DEMO_MODE) seed();
http.createServer(route).listen(PORT, () => {
  console.log(`Biashara OS running on http://localhost:${PORT}${cloud.enabled ? " (Supabase backup on)" : ""}`);
});

// Render stops the instance with SIGTERM: upload anything still pending first.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    try {
      await cloud.flush();
    } finally {
      process.exit(0);
    }
  });
}

// ── SMS alert scheduler ───────────────────────────────────────────────────────
// Sends three types of automatic SMS via Africa's Talking:
//   1. Low-stock alerts   — every hour (only when stock drops at or below reorder)
//   2. Debt reminders     — daily at 09:00 local time (unpaid / overdue debts)
//   3. Daily summary      — daily at 18:00 local time (revenue, expenses, profit)
//
// The owner's phone number (role = OWNER) is used as the recipient.
// Nothing is sent if AT credentials are absent or no company is configured.

function ownerPhone() {
  return get("SELECT phone FROM users WHERE role='OWNER' LIMIT 1")?.phone || null;
}

function sendLowStockSms() {
  const phone = ownerPhone();
  if (!phone || !companyId()) return;
  generateBusinessAlerts();
  const lowItems = all(`
    SELECT item_name, quantity, unit, reorder_level FROM inventory
    WHERE company_id = :cid AND item_type = 'RAW_MATERIAL' AND quantity <= reorder_level
  `, { cid: companyId() });
  if (!lowItems.length) return;
  const lines = lowItems.map(i => `${i.item_name}: ${i.quantity}${i.unit} (min ${i.reorder_level}${i.unit})`).join(", ");
  sendNotification({ channel: "SMS", recipient: phone, message: `[Biashara OS] LOW STOCK: ${lines}. Reorder now.`, provider: "africastalking" });
  console.log(`[SMS] Low-stock alert → ${phone} (${lowItems.length} items)`);
}

function sendDebtReminderSms() {
  const phone = ownerPhone();
  if (!phone || !companyId()) return;
  const debts = all(`
    SELECT c.name AS customer_name, cd.amount_owed - cd.amount_paid AS balance
    FROM customer_debts cd JOIN customers c ON c.id = cd.customer_id
    WHERE cd.company_id = :cid AND cd.status IN ('UNPAID','PARTIAL')
    ORDER BY balance DESC LIMIT 5
  `, { cid: companyId() });
  if (!debts.length) return;
  const total = debts.reduce((s, d) => s + Number(d.balance), 0);
  const lines = debts.map(d => `${d.customer_name} KSh ${Number(d.balance).toLocaleString()}`).join(", ");
  sendNotification({ channel: "SMS", recipient: phone, message: `[Biashara OS] DEBT REMINDER: Total owed to you KSh ${total.toLocaleString()}. Top: ${lines}.`, provider: "africastalking" });
  console.log(`[SMS] Debt reminder → ${phone} (KSh ${total.toLocaleString()} outstanding)`);
}

function sendDailySummarySms() {
  const phone = ownerPhone();
  if (!phone || !companyId()) return;
  const pl = getProfitAndLoss("today");
  const produced = get("SELECT COALESCE(SUM(quantity_produced),0) AS v FROM production_entries WHERE company_id=:cid AND date(created_at) = date('now')", { cid: companyId() })?.v || 0;
  sendNotification({
    channel: "SMS", recipient: phone,
    message: `[Biashara OS] Daily summary: Revenue KSh ${pl.revenue.toLocaleString()}, Expenses KSh ${pl.expenses.toLocaleString()}, Profit KSh ${pl.profit.toLocaleString()}, Units produced: ${produced}.`,
    provider: "africastalking"
  });
  console.log(`[SMS] Daily summary → ${phone}`);
}

// Schedule: run checks every minute, fire SMS at the right hours
const SMS_ALERT_INTERVAL_MS = 60 * 1000;
let lastLowStockHour = -1;
let lastDebtReminderDay = "";
let lastSummaryDay = "";

setInterval(() => {
  try {
    const d = new Date();
    const hh = d.getHours();
    const dayKey = d.toISOString().slice(0, 10);

    // Low stock — at most once per hour
    if (hh !== lastLowStockHour) {
      lastLowStockHour = hh;
      sendLowStockSms();
    }

    // Debt reminder — once per day at 09:00
    if (hh === 9 && lastDebtReminderDay !== dayKey) {
      lastDebtReminderDay = dayKey;
      sendDebtReminderSms();
    }

    // Daily summary — once per day at 18:00
    if (hh === 18 && lastSummaryDay !== dayKey) {
      lastSummaryDay = dayKey;
      sendDailySummarySms();
    }
  } catch (err) {
    console.error("[SMS scheduler error]", err.message);
  }
}, SMS_ALERT_INTERVAL_MS);
