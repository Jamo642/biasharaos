const form = document.getElementById("auth-form");
const errorBox = document.getElementById("auth-error");
const submit = document.getElementById("auth-submit");
const passwordInput = document.getElementById("password");
let mode = "login";

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

const authTitle = document.getElementById("auth-title");
const authSubtitle = document.getElementById("auth-subtitle");
const SIGN_IN_TEXT = { title: "Sign in", subtitle: "Welcome back. Sign in to your workspace." };
const SETUP_TEXT = { title: "Create owner account", subtitle: "First time here. Create the account that will manage this workspace." };

function setHeading({ title, subtitle }) {
  authTitle.textContent = title;
  authSubtitle.textContent = subtitle;
}

// With no account yet, the password form becomes "create owner account".
// The heading only changes while that form is on screen.
function useSetupMode() {
  mode = "register";
  if (!form.hidden) setHeading(SETUP_TEXT);
  document.getElementById("name-field").hidden = false;
  passwordInput.autocomplete = "new-password";
  submit.textContent = "Create account";
}

async function loadStatus() {
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    const status = await res.json();
    if (status.authenticated) return window.location.replace("/");
    if (status.needsSetup) useSetupMode();
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
  const body = {
    email: document.getElementById("email").value.trim(),
    password: passwordInput.value
  };
  if (mode === "register") body.name = document.getElementById("name").value.trim();
  if (!body.email || !body.password || (mode === "register" && !body.name)) {
    return showError("Please fill in every field.");
  }
  if (mode === "register" && body.password.length < 8) {
    return showError("Password must be at least 8 characters.");
  }
  submit.disabled = true;
  submit.textContent = mode === "register" ? "Creating…" : "Signing in…";
  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Sign in failed");
    window.location.replace("/");
  } catch (err) {
    showError(err.message);
    submit.disabled = false;
    submit.textContent = mode === "register" ? "Create account" : "Sign in";
  }
});

// Google sign-in: anyone with a Google account gets their own workspace.
// Only shown when the server has GOOGLE_CLIENT_ID configured.
const googleConfig = fetch("/api/auth/config", { credentials: "same-origin" })
  .then((res) => (res.ok ? res.json() : {}))
  .catch(() => ({}));

async function handleGoogleCredential(response) {
  showError("");
  try {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Google sign-in failed");
    window.location.replace("/");
  } catch (err) {
    showError(err.message);
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

// Email code sign-in: type an email, receive a 6-digit code, enter it.
// Shown instead of the password form when the server can send email.
const codeForm = document.getElementById("code-form");
const codeEmail = document.getElementById("code-email");
const codeField = document.getElementById("code-field");
const codeInput = document.getElementById("code");
const codeInfo = document.getElementById("code-info");
const codeSubmit = document.getElementById("code-submit");
const codeRestart = document.getElementById("code-restart");
const switchMode = document.getElementById("switch-mode");
let codeSent = false;

function showCodeStep(sent) {
  codeSent = sent;
  codeField.hidden = !sent;
  codeRestart.hidden = !sent;
  codeEmail.readOnly = sent;
  codeInfo.hidden = !sent;
  codeInfo.textContent = sent ? `We sent a code to ${codeEmail.value.trim()}. Check your spam folder if it is not in your inbox.` : "";
  codeSubmit.textContent = sent ? "Sign in" : "Email me a code";
  if (sent) codeInput.focus();
}

function showPasswordForm(usePassword) {
  form.hidden = !usePassword;
  setHeading(usePassword && mode === "register" ? SETUP_TEXT : SIGN_IN_TEXT);
  codeForm.hidden = usePassword;
  switchMode.textContent = usePassword ? "Email me a code instead" : "Use password instead";
  showError("");
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

codeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const email = codeEmail.value.trim();
  if (!email) return showError("Enter your email address.");
  const label = codeSubmit.textContent;
  codeSubmit.disabled = true;
  codeSubmit.textContent = codeSent ? "Signing in…" : "Sending…";
  try {
    if (!codeSent) {
      await postJson("/api/auth/email/request", { email });
      showCodeStep(true);
    } else {
      await postJson("/api/auth/email/verify", { email, code: codeInput.value.trim() });
      return window.location.replace("/");
    }
  } catch (err) {
    showError(err.message);
  }
  codeSubmit.disabled = false;
  if (codeSubmit.textContent.endsWith("…")) codeSubmit.textContent = label;
});

codeRestart.addEventListener("click", () => {
  codeInput.value = "";
  showError("");
  showCodeStep(false);
});

switchMode.addEventListener("click", () => showPasswordForm(form.hidden));

googleConfig.then(({ emailCodes }) => {
  if (!emailCodes) return;
  switchMode.hidden = false;
  showPasswordForm(false);
});

loadStatus();
