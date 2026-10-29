// Email + password and Google sign-in for the dashboard.
// Passwords are hashed with scrypt; sessions are random tokens stored (hashed)
// in SQLite and sent to the browser as an HttpOnly cookie.
// Google accounts each get their own workspace ("tenant"); accounts with no
// tenant use the original shared database.
const { randomBytes, randomUUID, scryptSync, createHash, timingSafeEqual } = require("node:crypto");

const COOKIE_NAME = "bos_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

function createAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL, FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);
  const accountColumns = db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name);
  if (!accountColumns.includes("tenant")) db.exec("ALTER TABLE accounts ADD COLUMN tenant TEXT");

  const failures = new Map();

  const hashToken = (token) => createHash("sha256").update(token).digest("hex");

  function hashPassword(password) {
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
  }

  function verifyPassword(password, stored) {
    const [scheme, saltHex, keyHex] = String(stored || "").split("$");
    if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
    const expected = Buffer.from(keyHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return timingSafeEqual(actual, expected);
  }

  function validateCredentials({ email, password }) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) throw httpError(400, "Enter a valid email address");
    if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > 200) {
      throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
    }
    return { email: cleanEmail, password };
  }

  function accountCount() {
    return db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  }

  function createSession(accountId) {
    const token = randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(Date.now());
    db.prepare("INSERT INTO auth_sessions VALUES (?,?,?,?)")
      .run(hashToken(token), accountId, Date.now() + SESSION_TTL_MS, new Date().toISOString());
    return token;
  }

  // Only allowed while no account exists: the first visitor becomes the owner.
  function registerFirstAccount(data) {
    if (accountCount() > 0) throw httpError(403, "An account already exists. Please sign in.");
    const { email, password } = validateCredentials(data);
    const name = String(data.name || "").trim().slice(0, 120);
    if (!name) throw httpError(400, "Enter your name");
    const id = randomUUID();
    db.prepare("INSERT INTO accounts (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)")
      .run(id, email, name, hashPassword(password), new Date().toISOString());
    return { token: createSession(id), account: { id, email, name } };
  }

  // `claims` must already be verified as a genuine Google ID token for this app.
  // An existing account with the same email is reused; otherwise a new account
  // with its own empty workspace is created.
  function googleLogin(claims) {
    const email = String(claims.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, "Google account has no usable email");
    const existing = db.prepare("SELECT id, email, name, tenant FROM accounts WHERE email = ?").get(email);
    if (existing) {
      return { token: createSession(existing.id), account: { id: existing.id, email, name: existing.name, tenant: existing.tenant }, isNew: false };
    }
    const name = String(claims.name || email.split("@")[0]).trim().slice(0, 120);
    const id = randomUUID();
    const tenant = randomUUID();
    // "google" is not a valid scrypt hash, so password sign-in stays impossible for this account.
    db.prepare("INSERT INTO accounts (id, email, name, password_hash, created_at, tenant) VALUES (?,?,?,?,?,?)")
      .run(id, email, name, "google", new Date().toISOString(), tenant);
    return { token: createSession(id), account: { id, email, name, tenant }, isNew: true };
  }

  function login(data, ip) {
    const bucket = failures.get(ip);
    if (bucket && bucket.reset > Date.now() && bucket.count >= LOGIN_MAX_FAILURES) {
      throw httpError(429, "Too many failed attempts. Try again in 15 minutes.");
    }
    const email = String(data.email || "").trim().toLowerCase();
    const password = typeof data.password === "string" ? data.password : "";
    const account = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
    if (!account || !verifyPassword(password, account.password_hash)) {
      const current = bucket && bucket.reset > Date.now() ? bucket : { count: 0, reset: Date.now() + LOGIN_WINDOW_MS };
      failures.set(ip, { ...current, count: current.count + 1 });
      throw httpError(401, "Wrong email or password");
    }
    failures.delete(ip);
    return { token: createSession(account.id), account: { id: account.id, email: account.email, name: account.name } };
  }

  function readToken(req) {
    const cookies = String(req.headers.cookie || "").split(";");
    for (const part of cookies) {
      const [key, ...rest] = part.trim().split("=");
      if (key === COOKIE_NAME) return rest.join("=");
    }
    return "";
  }

  function currentAccount(req) {
    const token = readToken(req);
    if (!token) return null;
    const row = db.prepare(`
      SELECT a.id, a.email, a.name, a.tenant, s.expires_at FROM auth_sessions s
      JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?
    `).get(hashToken(token));
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, email: row.email, name: row.name, tenant: row.tenant };
  }

  function logout(req) {
    const token = readToken(req);
    if (token) db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
  }

  function sessionCookie(req, token) {
    const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
    const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
    return `${COOKIE_NAME}=${token || ""}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
  }

  return { accountCount, registerFirstAccount, googleLogin, login, logout, currentAccount, sessionCookie };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

module.exports = { createAuth };
