// Sign-in page with three views:
//   signin – email + password (the main way in)
//   signup – name + email + password; an emailed code confirms the address
//   code   – email-only sign-in: the code is sent and checked automatically
// Google sign-in sits above all three and also finishes with an emailed code.
const form = document.getElementById("auth-form");
const errorBox = document.getElementById("auth-error");
const submit = document.getElementById("auth-submit");
const nameField = document.getElementById("name-field");
const nameInput = document.getElementById("name");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const authTitle = document.getElementById("auth-title");
const authSubtitle = document.getElementById("auth-subtitle");
const switchText = document.getElementById("switch-text");
const switchMode = document.getElementById("switch-mode");
const useCode = document.getElementById("use-code");
const codeForm = document.getElementById("code-form");
const codeEmail = document.getElementById("code-email");
const codeField = document.getElementById("code-field");
const codeInput = document.getElementById("code");
const codeRestart = document.getElementById("code-restart");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const AUTO_SEND_DELAY_MS = 1500;
const MIN_PASSWORD = 8;
const VIEWS = {
  signin: {
    title: "Sign in", subtitle: "Welcome back. Sign in to your workspace.", submit: "Sign in",
    switchText: "New to Biashara OS?", switchLabel: "Create an account", switchTo: "signup"
  },
  signup: {
    title: "Create your account", subtitle: "Set up your own Biashara OS workspace.", submit: "Create account",
    switchText: "Already have an account?", switchLabel: "Sign in", switchTo: "signin"
  },
  code: {
    title: "Sign in with a code", subtitle: "We'll email you a 6-digit code.",
    switchText: "Remember your password?", switchLabel: "Sign in", switchTo: "signin"
  }
};

let view = "signin";
let codeSent = false;
let busy = false;
let sendTimer = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

function showView(next) {
  view = next;
  const config = VIEWS[next];
  authTitle.textContent = config.title;
  authSubtitle.textContent = config.subtitle;
  switchText.textContent = config.switchText;
  switchMode.textContent = config.switchLabel;
  const usesPasswordForm = next !== "code";
  form.hidden = !usesPasswordForm;
  codeForm.hidden = usesPasswordForm;
  nameField.hidden = next !== "signup";
  useCode.hidden = next !== "signin";
  if (usesPasswordForm) submit.textContent = config.submit;
  passwordInput.autocomplete = next === "signup" ? "new-password" : "current-password";
  showCodeStep(false);
  showError("");
}

// The code step is shared by email-code sign-in, sign-up and Google.
function showCodeStep(sent) {
  codeSent = sent;
  codeField.hidden = !sent;
  codeRestart.hidden = !sent;
  codeEmail.readOnly = sent;
  if (!sent) codeInput.value = "";
  if (sent) codeInput.focus();
}

// Used after sign-up or Google: switch to the code view with the email filled in.
function waitForCode(email, title) {
  showView("code");
  if (title) authTitle.textContent = title;
  authSubtitle.textContent = `Enter the 6-digit code we emailed to ${email}.`;
  codeEmail.value = email;
  showCodeStep(true);
}

async function loadStatus() {
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    const status = await res.json();
    if (status.authenticated) window.location.replace("/");
  } catch {
    showError("Cannot reach the server. Check your connection and try again.");
  }
}

document.getElementById("toggle-password").addEventListener("click", (event) => {
  const hidden = passwordInput.type === "password";
  passwordInput.type = hidden ? "text" : "password";
  event.currentTarget.textContent = hidden ? "Hide" : "Show";
  event.currentTarget.setAttribute("aria-label", hidden ? "Hide password" : "Show password");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const name = nameInput.value.trim();
  if (!email || !password || (view === "signup" && !name)) return showError("Please fill in every field.");
  if (view === "signup" && password.length < MIN_PASSWORD) return showError(`Password must be at least ${MIN_PASSWORD} characters.`);
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = view === "signup" ? "Creating…" : "Signing in…";
  try {
    if (view === "signup") {
      const data = await postJson("/api/auth/signup", { name, email, password });
      submit.disabled = false;
      submit.textContent = label;
      return waitForCode(data.email, "Confirm your email");
    }
    await postJson("/api/auth/login", { email, password });
    return window.location.replace("/");
  } catch (err) {
    showError(err.message);
  }
  submit.disabled = false;
  submit.textContent = label;
});

async function sendCode() {
  clearTimeout(sendTimer);
  const email = codeEmail.value.trim();
  if (codeSent || busy || !EMAIL_PATTERN.test(email)) return;
  busy = true;
  showError("");
  try {
    await postJson("/api/auth/email/request", { email });
    showCodeStep(true);
  } catch (err) {
    showError(err.message);
  }
  busy = false;
}

async function verifyCode() {
  const code = codeInput.value.replace(/\D/g, "");
  if (!codeSent || busy || code.length !== 6) return;
  busy = true;
  showError("");
  codeInput.readOnly = true;
  try {
    await postJson("/api/auth/email/verify", { email: codeEmail.value.trim(), code });
    return window.location.replace("/");
  } catch (err) {
    showError(err.message);
    codeInput.value = "";
    codeInput.focus();
  }
  codeInput.readOnly = false;
  busy = false;
}

// No buttons in the code view: the code is emailed once a complete address is
// typed (short pause, Enter, or leaving the field) and checked at 6 digits.
codeEmail.addEventListener("input", () => {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(sendCode, AUTO_SEND_DELAY_MS);
});
codeEmail.addEventListener("blur", sendCode);
codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
  verifyCode();
});
codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (codeSent) verifyCode();
  else sendCode();
});

codeRestart.addEventListener("click", () => {
  showError("");
  showCodeStep(false);
  authSubtitle.textContent = VIEWS.code.subtitle;
  codeEmail.focus();
});

switchMode.addEventListener("click", () => showView(VIEWS[view].switchTo));
useCode.addEventListener("click", () => {
  showView("code");
  if (EMAIL_PATTERN.test(emailInput.value.trim())) codeEmail.value = emailInput.value.trim();
  codeEmail.focus();
});

// Google sign-in: Google confirms the account, then an emailed code finishes it.
// Only shown when the server has GOOGLE_CLIENT_ID configured.
const googleConfig = fetch("/api/auth/config", { credentials: "same-origin" })
  .then((res) => (res.ok ? res.json() : {}))
  .catch(() => ({}));

async function handleGoogleCredential(response) {
  showError("");
  try {
    const data = await postJson("/api/auth/google", { credential: response.credential });
    if (!data.codeSent) return window.location.replace("/");
    waitForCode(data.email, "Confirm it's you");
  } catch (err) {
    showError(err.message || "Google sign-in failed");
  }
}

window.initGoogleSignIn = async function initGoogleSignIn() {
  const { googleClientId } = await googleConfig;
  if (!googleClientId || !window.google?.accounts?.id) return;
  google.accounts.id.initialize({ client_id: googleClientId, callback: handleGoogleCredential });
  google.accounts.id.renderButton(document.getElementById("google-button"), {
    theme: "outline", size: "large", text: "continue_with", shape: "rectangular", width: 320
  });
  document.getElementById("google-block").hidden = false;
};

// Without email codes the "use a code" option and sign-up can't work.
googleConfig.then(({ emailCodes }) => {
  if (emailCodes) return;
  useCode.hidden = true;
  switchMode.parentElement.hidden = true;
});

showView("signin");
loadStatus();
