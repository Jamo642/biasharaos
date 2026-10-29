const form = document.getElementById("auth-form");
const errorBox = document.getElementById("auth-error");
const submit = document.getElementById("auth-submit");
const passwordInput = document.getElementById("password");
let mode = "login";

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

// With no account yet, the page becomes "create owner account".
function useSetupMode() {
  mode = "register";
  document.getElementById("auth-title").textContent = "Create owner account";
  document.getElementById("auth-subtitle").textContent = "First time here. Create the account that will manage this workspace.";
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

loadStatus();
