const form = document.getElementById("login-form");
const error = document.getElementById("login-error");
const button = form.querySelector("button");

const showError = (message) => {
  error.textContent = message;
  error.hidden = false;
};

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
    });
    if (res.ok) return location.replace("/admin/");
    const data = await res.json().catch(() => null);
    showError((data && data.error) || `Sign-in failed (${res.status})`);
    form.password.select();
  } catch {
    showError("Could not reach the server");
  } finally {
    button.disabled = false;
  }
});
