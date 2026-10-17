// Admin UI for the ZKTeco ADMS Worker. Every device- or tenant-provided string is
// rendered via textContent (see h()); never use innerHTML with API data.
// The CSP forbids inline scripts and style attributes: use classes from styles.css.

const API = "/api/admin";
const ONLINE_POLL_MS = 10000;
const COMMAND_POLL_MS = 3000;
const PAGE_SIZE = 50;

const main = document.getElementById("main");
const toastBox = document.getElementById("toasts");

// Sign-out goes through api() so it is sent as JSON (the CSRF guard rejects form posts).
document.getElementById("logout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("POST", "/logout");
  } finally {
    location.replace("/admin/login");
  }
});

let timers = [];
let routeToken = 0;

// ---------- helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

let idSeq = 0;
function field(label, input, cls) {
  const id = input.id || `f${++idSeq}`;
  input.id = id;
  return h("div", { class: cls ? `field ${cls}` : "field" }, h("label", { for: id, text: label }), input);
}

function checkbox(label, input) {
  return h("label", { class: "check" }, input, label);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  // Mutations must be JSON (the server's CSRF guard), so always send a body with them.
  if (body !== undefined || (method !== "GET" && method !== "DELETE")) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body || {});
  }
  let res;
  try {
    res = await fetch(API + path, opts);
  } catch (e) {
    throw new ApiError("Network error: could not reach the server", 0);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  if (res.status === 401) {
    // Session expired or signed out in another tab.
    location.replace("/admin/login");
    throw new ApiError("Signed out", 401);
  }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return data;
}

function toast(message, type = "info") {
  const el = h("div", { class: `toast ${type}`, role: type === "error" ? "alert" : undefined, text: message });
  toastBox.append(el);
  setTimeout(() => el.remove(), type === "error" ? 7000 : 4000);
}

function every(ms, fn) {
  const id = setInterval(fn, ms);
  timers.push(id);
  return id;
}

function stopTimer(id) {
  clearInterval(id);
  timers = timers.filter((t) => t !== id);
}

function clearTimers() {
  timers.forEach(clearInterval);
  timers = [];
}

function relTime(iso) {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < -60) return fmtTime(iso);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function dash(value) {
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function devicePath(sn) {
  return `/devices/${encodeURIComponent(sn)}`;
}

function tenantPath(id) {
  return `/tenants/${encodeURIComponent(id)}`;
}

function deviceLabel(d) {
  return d.name || d.sn;
}

function queuedMessage(result, what) {
  const n = result && Array.isArray(result.commands) ? result.commands.length : 0;
  return `${what}: queued ${plural(n, "command")}. The device runs them on its next poll.`;
}

const ACCESS_LABELS = {
  approved: "Approved",
  allowlist: "Allowlist",
  pending: "Pending",
  disabled: "Disabled",
};

function accessBadge(access) {
  const key = ACCESS_LABELS[access] ? access : "pending";
  return h("span", { class: `badge ${key}`, text: ACCESS_LABELS[key] });
}

const DELIVERY_LABELS = {
  held: "Held",
  pending: "Pending",
  delivered: "Delivered",
  failed: "Failed",
};

function deliveryBadge(status, title) {
  return h("span", { class: `badge ${status}`, title: title || undefined, text: DELIVERY_LABELS[status] || dash(status) });
}

function statusDot(online) {
  return h("span", {
    class: online ? "dot on" : "dot",
    role: "img",
    "aria-label": online ? "Online" : "Offline",
    title: online ? "Online" : "Offline",
  });
}

function typeLabel(t) {
  if (t === "acc") return "Access";
  if (t === "att") return "Attendance";
  return dash(t);
}

// Replace a button with an inline "are you sure" prompt.
function confirmButton(label, { prompt, confirmLabel, onConfirm, className = "btn-danger" }) {
  const wrap = h("span", { class: "confirm" });
  const showButton = () => {
    clear(wrap);
    wrap.append(h("button", { type: "button", class: className, text: label, onclick: showConfirm }));
  };
  const showConfirm = () => {
    clear(wrap);
    const yes = h("button", {
      type: "button",
      class: "btn-danger-solid",
      text: confirmLabel || label,
      onclick: async () => {
        yes.disabled = true;
        try {
          await onConfirm();
        } finally {
          if (wrap.isConnected) showButton();
        }
      },
    });
    const no = h("button", { type: "button", text: "Cancel", onclick: showButton });
    wrap.append(h("span", { class: "confirm-text", text: prompt || "Are you sure?" }), yes, no);
    no.focus();
  };
  showButton();
  return wrap;
}

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

function tableWrap(headers, tbody) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, headers.map((x) => (typeof x === "string" ? h("th", { scope: "col", text: x }) : x)))),
      tbody
    )
  );
}

function emptyRow(colspan, text) {
  return h("tr", {}, h("td", { colspan: String(colspan), class: "empty", text }));
}

function pageHead(title, sub, ...actions) {
  return h(
    "div",
    { class: "page-head" },
    h("div", {}, typeof title === "string" ? h("h1", { text: title }) : title, sub ? h("p", { class: "sub", text: sub }) : null),
    actions.length ? h("div", { class: "btn-row" }, actions) : null
  );
}

function renderFatal(err) {
  clear(main);
  const lead = err.status === 503 ? "Admin UI unavailable. " : "Something went wrong. ";
  main.append(h("div", { class: "notice" }, h("strong", { text: lead }), err.message));
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "ok");
  } catch (e) {
    // Clipboard API needs a secure context; fall back to selecting the text.
    input.focus();
    input.select();
    toast("Press Ctrl+C / Cmd+C to copy", "info");
  }
}

// Shows a freshly issued tenant API key. It is never retrievable again.
function secretPanel(apiKey, tenantName) {
  const input = h("input", { value: apiKey, readonly: true, "aria-label": "API key", spellcheck: "false" });
  const panel = h(
    "section",
    { class: "secret", role: "alert" },
    h("p", {}, h("strong", { text: `API key for ${tenantName}. ` }), "Copy it now and paste it into the POS settings. It will not be shown again."),
    h(
      "div",
      { class: "btn-row" },
      input,
      h("button", { type: "button", class: "btn-primary", text: "Copy", onclick: () => copyText(apiKey, input) }),
      h("button", { type: "button", text: "Done", onclick: () => panel.remove() })
    )
  );
  setTimeout(() => input.select(), 0);
  return panel;
}

let tenantsCache = null;
async function loadTenants(force) {
  if (!tenantsCache || force) tenantsCache = api("GET", "/tenants").catch((err) => ((tenantsCache = null), Promise.reject(err)));
  return tenantsCache;
}

function tenantOptions(select, tenants, { allLabel, noneLabel, selected } = {}) {
  clear(select);
  if (allLabel) select.append(h("option", { value: "", text: allLabel }));
  if (noneLabel) select.append(h("option", { value: "none", text: noneLabel }));
  tenants.forEach((t) => select.append(h("option", { value: t.id, text: t.enabled ? t.name : `${t.name} (disabled)` })));
  select.value = selected || "";
}

function timezoneList() {
  const list = h("datalist", { id: `tz${++idSeq}` });
  try {
    Intl.supportedValuesOf("timeZone").forEach((tz) => list.append(h("option", { value: tz })));
  } catch (e) {
    // older browsers: free text only
  }
  return list;
}

// ---------- devices list ----------

async function viewDevices(token, params) {
  clear(main);
  main.append(pageHead("Devices", "Devices that have contacted this server. Assign a device to a tenant to start delivering its punches."));

  const statusSel = h(
    "select",
    { name: "status" },
    h("option", { value: "", text: "All statuses" }),
    h("option", { value: "pending", text: "Pending" }),
    h("option", { value: "approved", text: "Approved" }),
    h("option", { value: "disabled", text: "Disabled" })
  );
  const tenantSel = h("select", { name: "tenantId" }, h("option", { value: "", text: "All tenants" }));
  statusSel.value = params.get("status") || "";
  const initialTenant = params.get("tenantId") || "";
  statusSel.addEventListener("change", load);
  tenantSel.addEventListener("change", load);

  const tbody = h("tbody", {}, emptyRow(10, "Loading…"));
  main.append(
    h("section", { class: "card", "aria-label": "Filters" }, h("div", { class: "form" }, field("Status", statusSel), field("Tenant", tenantSel))),
    h(
      "section",
      { class: "card flush", "aria-label": "Device list" },
      tableWrap(
        [
          h("th", { scope: "col", "aria-label": "Online" }),
          "Name",
          "Access",
          "Tenant",
          "Branch",
          "Last seen",
          "Serial",
          "Type",
          "Firmware",
          h("th", { scope: "col", class: "num", text: "Users" }),
        ],
        tbody
      )
    )
  );

  let tenantNames = new Map();
  try {
    const tenants = await loadTenants(true);
    if (token !== routeToken) return;
    tenantNames = new Map(tenants.map((t) => [t.id, t.name]));
    tenantOptions(tenantSel, tenants, { allLabel: "All tenants", noneLabel: "Unassigned", selected: initialTenant });
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 503) return renderFatal(err);
    toast(err.message, "error");
  }

  async function setStatus(d, status, btn) {
    await withBusy(btn, async () => {
      try {
        await api("PATCH", devicePath(d.sn), { status });
        toast(`${deviceLabel(d)} ${status}`, "ok");
        await load();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  function row(d) {
    const access = h("td", {}, accessBadge(d.access));
    if (d.status === "pending") {
      const approve = h("button", { type: "button", class: "btn-sm btn-primary ml-8", text: "Approve" });
      approve.addEventListener("click", () => setStatus(d, "approved", approve));
      const disable = h("button", { type: "button", class: "btn-sm btn-danger ml-8", text: "Disable" });
      disable.addEventListener("click", () => setStatus(d, "disabled", disable));
      access.append(approve, disable);
    }
    const tenant = d.tenantId
      ? h("a", { href: `#${tenantPath(d.tenantId)}`, text: tenantNames.get(d.tenantId) || d.tenantId })
      : h("span", { class: "muted", text: "Unassigned" });
    return h(
      "tr",
      {},
      h("td", {}, statusDot(d.online)),
      h("td", {}, h("a", { href: `#${devicePath(d.sn)}`, class: "row-link", text: deviceLabel(d) })),
      access,
      h("td", {}, tenant),
      h("td", { class: "mono", text: dash(d.branchId) }),
      h("td", { title: fmtTime(d.lastSeen), text: relTime(d.lastSeen) }),
      h("td", { class: "mono", text: d.sn }),
      h("td", { text: typeLabel(d.deviceType) }),
      h("td", { class: "mono", text: dash(d.firmware) }),
      h("td", { class: "num", text: String(d.userCount || 0) })
    );
  }

  let failed = false;
  async function load() {
    const q = new URLSearchParams();
    if (statusSel.value) q.set("status", statusSel.value);
    if (tenantSel.value) q.set("tenantId", tenantSel.value);
    const qs = q.toString() ? `?${q}` : "";
    history.replaceState(null, "", `#/devices${qs}`);
    try {
      const devices = await api("GET", `/devices${qs}`);
      if (token !== routeToken) return;
      failed = false;
      clear(tbody);
      if (!devices || !devices.length) {
        tbody.append(emptyRow(10, qs ? "No devices match these filters." : "No devices yet. Point a device at this server; it shows up here as pending."));
      } else {
        devices.forEach((d) => tbody.append(row(d)));
      }
    } catch (err) {
      if (token !== routeToken) return;
      if (err.status === 503) return renderFatal(err);
      if (!failed) toast(err.message, "error");
      failed = true;
    }
  }

  await load();
  every(ONLINE_POLL_MS, load);
}

// ---------- device detail ----------

async function viewDevice(token, sn, tab) {
  clear(main);
  main.append(h("p", { class: "spinner-text", text: "Loading device…" }));

  let device;
  let tenants = [];
  try {
    [device, tenants] = await Promise.all([api("GET", devicePath(sn)), loadTenants(true).catch(() => [])]);
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 404) {
      clear(main);
      main.append(h("a", { class: "crumb", href: "#/devices", text: "← Devices" }), h("div", { class: "notice", text: `Device ${sn} was not found.` }));
      return;
    }
    return renderFatal(err);
  }
  if (token !== routeToken) return;

  const isAcc = device.deviceType === "acc";
  const tenantName = (id) => (tenants.find((t) => t.id === id) || {}).name || id;
  clear(main);

  // Header
  const titleEl = h("h1", { text: deviceLabel(device) });
  const headDot = h("span", {});
  const headSeen = h("span", { class: "muted" });
  const headAccess = h("span", {});
  function paintHead(d) {
    titleEl.textContent = deviceLabel(d);
    clear(headDot).append(statusDot(d.online));
    headSeen.textContent = `${d.online ? "Online" : "Offline"} · last seen ${relTime(d.lastSeen)}`;
    clear(headAccess).append(accessBadge(d.access));
  }
  main.append(
    h("a", { class: "crumb", href: "#/devices", text: "← Devices" }),
    h("div", { class: "page-head" }, h("div", {}, titleEl, h("p", { class: "sub btn-row" }, headDot, headSeen, headAccess)))
  );
  paintHead(device);

  // Info
  const infoList = h("dl", { class: "kv" });
  const rawInfo = h("details", { class: "raw" });
  function paintInfo(d) {
    clear(infoList);
    const items = [
      ["Serial", d.sn, true],
      ["Tenant", d.tenantId ? tenantName(d.tenantId) : "Unassigned"],
      ["Branch", dash(d.branchId)],
      ["Type", typeLabel(d.deviceType)],
      ["Firmware", dash(d.firmware)],
      ["Push version", dash(d.pushVersion)],
      ["IP address", dash(d.ip), true],
      ["User agent", dash(d.userAgent)],
      ["Last seen", d.lastSeen ? fmtTime(d.lastSeen) : "never"],
      ["First seen", d.createdAt ? fmtTime(d.createdAt) : "—"],
      ["Users", String(d.userCount || 0)],
    ];
    items.forEach(([k, v, mono]) => infoList.append(h("dt", { text: k }), h("dd", { class: mono ? "mono" : undefined, text: v })));
    clear(rawInfo);
    const info = d.info && typeof d.info === "object" ? d.info : {};
    const keys = Object.keys(info).sort();
    if (keys.length) {
      const kv = h("dl", { class: "kv mono" });
      keys.forEach((k) => kv.append(h("dt", { text: k }), h("dd", { text: typeof info[k] === "string" ? info[k] : JSON.stringify(info[k]) })));
      rawInfo.append(h("summary", { text: `Reported device options (${keys.length})` }), kv);
      rawInfo.hidden = false;
    } else {
      rawInfo.hidden = true;
    }
  }
  paintInfo(device);

  function repaint(d) {
    device = { ...device, ...d };
    paintHead(device);
    paintInfo(device);
    paintAssignment();
    paintApproval();
  }

  async function patchDevice(body, message) {
    try {
      repaint(await api("PATCH", devicePath(sn), body));
      toast(message, "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // Settings: name
  const nameInput = h("input", { value: device.name || "", maxlength: "100", autocomplete: "off", placeholder: device.sn });
  const saveBtn = h("button", { type: "submit", class: "btn-primary", text: "Save" });
  const nameForm = h(
    "form",
    {
      class: "form",
      onsubmit: (e) => {
        e.preventDefault();
        withBusy(saveBtn, () => patchDevice({ name: nameInput.value.trim() || null }, "Name saved"));
      },
    },
    field("Display name", nameInput),
    h("div", { class: "actions" }, saveBtn)
  );

  // Assignment: tenant + branch
  const tenantSel = h("select", {});
  const branchIn = h("input", { type: "number", min: "0", step: "1", inputmode: "numeric", placeholder: "POS branch id" });
  const assignBtn = h("button", { type: "submit", class: "btn-primary", text: "Save assignment" });
  const assignNote = h("p", { class: "muted mb-12" });
  const unassignBox = h("span", {});
  function paintAssignment() {
    tenantOptions(tenantSel, tenants, { allLabel: "— Unassigned —", selected: device.tenantId || "" });
    if (device.tenantId && !tenants.some((t) => t.id === device.tenantId)) {
      tenantSel.append(h("option", { value: device.tenantId, text: device.tenantId }));
      tenantSel.value = device.tenantId;
    }
    branchIn.value = device.branchId === null || device.branchId === undefined ? "" : String(device.branchId);
    assignNote.textContent = device.tenantId
      ? `Punches are delivered to ${tenantName(device.tenantId)}. Changing the branch also updates punches not yet delivered.`
      : "Not assigned. Punches from an admitted device are held until it is assigned to a tenant, then delivered.";
    clear(unassignBox);
    if (device.tenantId) {
      unassignBox.append(
        confirmButton("Unassign", {
          prompt: "Unassign from tenant?",
          confirmLabel: "Unassign",
          onConfirm: () => patchDevice({ tenantId: null, branchId: null }, "Device unassigned"),
        })
      );
    }
  }
  const assignForm = h(
    "form",
    {
      class: "form",
      onsubmit: (e) => {
        e.preventDefault();
        const tenantId = tenantSel.value || null;
        const raw = branchIn.value.trim();
        const branchId = raw === "" ? null : Number(raw);
        if (branchId !== null && (!Number.isInteger(branchId) || branchId < 0)) return toast("Branch must be a whole number", "error");
        if (!tenantId && device.tenantId) return toast("Use Unassign to remove the tenant", "error");
        const body = { branchId };
        if (tenantId && tenantId !== device.tenantId) body.tenantId = tenantId;
        withBusy(assignBtn, () => patchDevice(body, tenantId ? "Assignment saved; device approved" : "Branch saved"));
      },
    },
    field("Tenant", tenantSel),
    field("Branch ID", branchIn, "narrow"),
    h("div", { class: "actions btn-row" }, assignBtn, unassignBox)
  );
  paintAssignment();

  // Access: approve / disable
  const approvalBox = h("div", { class: "btn-row" });
  function paintApproval() {
    clear(approvalBox);
    const desc =
      device.status === "approved"
        ? "Approved: the device may push data to this server."
        : device.status === "disabled"
          ? device.access === "allowlist"
            ? "Disabled, but still admitted through ALLOWED_SERIALS."
            : "Disabled: its requests are refused."
          : device.access === "allowlist"
            ? "Admitted through ALLOWED_SERIALS. Approve it here to keep access if the allowlist changes."
            : "Waiting for approval. Its requests are refused until you approve it or assign it to a tenant.";
    approvalBox.append(h("p", { class: "muted grow", text: desc }));
    if (device.status !== "approved") {
      const btn = h("button", { type: "button", class: "btn-primary", text: "Approve device" });
      btn.addEventListener("click", () => withBusy(btn, () => patchDevice({ status: "approved" }, "Device approved")));
      approvalBox.append(btn);
    }
    if (device.status !== "disabled") {
      approvalBox.append(
        confirmButton("Disable", {
          prompt: "Disable this device?",
          confirmLabel: "Disable",
          onConfirm: () => patchDevice({ status: "disabled" }, "Device disabled"),
        })
      );
    }
  }
  paintApproval();

  const deleteBox = h(
    "div",
    { class: "btn-row" },
    h("p", { class: "muted grow", text: "Removes the device, its synced user list and command history. Punches are kept. If it connects again it shows up as pending." }),
    confirmButton("Delete device", {
      prompt: "Delete this device?",
      confirmLabel: "Delete",
      onConfirm: async () => {
        try {
          await api("DELETE", devicePath(sn));
          toast(`Device ${sn} deleted`, "ok");
          location.hash = "#/devices";
        } catch (err) {
          toast(err.message, "error");
        }
      },
    })
  );

  main.append(
    h(
      "div",
      { class: "grid-2" },
      h("section", { class: "card", "aria-labelledby": "info-h" }, h("h2", { id: "info-h", text: "Device info" }), infoList, rawInfo),
      h(
        "section",
        { class: "card", "aria-labelledby": "settings-h" },
        h("h2", { id: "settings-h", text: "Settings" }),
        nameForm,
        h("hr", { class: "sep" }),
        h("h2", { text: "Tenant and branch" }),
        assignNote,
        assignForm,
        h("hr", { class: "sep" }),
        h("h2", { text: "Access" }),
        approvalBox,
        h("hr", { class: "sep" }),
        h("h2", { text: "Danger zone" }),
        deleteBox
      )
    )
  );

  // Tabs
  const tabs = [
    ["users", "Users"],
    ["actions", "Actions"],
    ["commands", "Commands"],
  ];
  if (!tabs.some(([k]) => k === tab)) tab = "users";
  const tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Device sections" });
  const panels = {};
  tabs.forEach(([key, label]) => {
    tabBar.append(
      h("button", {
        type: "button",
        role: "tab",
        id: `tab-${key}`,
        "aria-controls": `panel-${key}`,
        "aria-selected": String(key === tab),
        tabindex: key === tab ? "0" : "-1",
        text: label,
        onclick: () => selectTab(key),
      })
    );
    panels[key] = h("section", { id: `panel-${key}`, role: "tabpanel", "aria-labelledby": `tab-${key}`, hidden: key !== tab });
  });
  tabBar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = tabs.findIndex(([k]) => k === tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
    selectTab(next);
    document.getElementById(`tab-${next}`).focus();
  });
  function selectTab(key) {
    tab = key;
    tabs.forEach(([k]) => {
      const btn = document.getElementById(`tab-${k}`);
      btn.setAttribute("aria-selected", String(k === key));
      btn.setAttribute("tabindex", k === key ? "0" : "-1");
      panels[k].hidden = k !== key;
    });
    history.replaceState(null, "", `#${devicePath(sn)}?tab=${key}`);
  }
  main.append(tabBar, panels.users, panels.actions, panels.commands);

  // Users tab
  const usersBody = h("tbody", {}, emptyRow(6, "Loading…"));
  const usersCount = h("span", { class: "muted" });
  async function loadUsers() {
    try {
      const users = await api("GET", `${devicePath(sn)}/users`);
      if (token !== routeToken) return;
      clear(usersBody);
      usersCount.textContent = plural(users.length, "user");
      if (!users.length) {
        usersBody.append(emptyRow(6, "No users known for this device. Use “Fetch users” to read them from the device."));
        return;
      }
      users.forEach((u) => {
        usersBody.append(
          h(
            "tr",
            {},
            h("td", { class: "mono", text: u.pin }),
            h("td", { text: dash(u.name) }),
            h("td", { class: "mono", text: dash(u.cardNo) }),
            h("td", { text: Number(u.privilege) > 0 ? "Admin" : "User" }),
            h("td", { class: "muted", title: fmtTime(u.updatedAt), text: u.updatedAt ? relTime(u.updatedAt) : "—" }),
            h(
              "td",
              { class: "num" },
              confirmButton("Delete", {
                prompt: "Remove?",
                confirmLabel: "Remove",
                className: "btn-sm btn-danger",
                onConfirm: async () => {
                  try {
                    const r = await api("DELETE", `${devicePath(sn)}/users/${encodeURIComponent(u.pin)}`);
                    toast(queuedMessage(r, `Delete user ${u.pin}`), "ok");
                    await Promise.all([loadUsers(), loadCommands()]);
                  } catch (err) {
                    toast(err.message, "error");
                  }
                },
              })
            )
          )
        );
      });
    } catch (err) {
      if (token !== routeToken) return;
      clear(usersBody).append(emptyRow(6, err.message));
    }
  }

  const pinIn = h("input", { name: "pin", required: true, inputmode: "numeric", pattern: "\\d{1,24}", autocomplete: "off", maxlength: "24", placeholder: "e.g. 1001" });
  const unameIn = h("input", { name: "name", required: true, autocomplete: "off", maxlength: "24", placeholder: "Full name" });
  const cardIn = h("input", { name: "cardNo", autocomplete: "off", inputmode: "numeric", maxlength: "20", placeholder: "Optional" });
  // "admin" is the ZKTeco superuser (privilege 14); "user" is a normal user.
  const privIn = h("select", { name: "privilege" }, h("option", { value: "user", text: "User" }), h("option", { value: "admin", text: "Admin" }));
  const pwIn = h("input", { name: "password", type: "password", autocomplete: "new-password", maxlength: "8", placeholder: "Optional" });
  const addUserBtn = h("button", { type: "submit", class: "btn-primary", text: "Save user" });
  const userForm = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        const pin = pinIn.value.trim();
        const name = unameIn.value.trim();
        if (!pin || !name) return toast("PIN and name are required", "error");
        if (!/^\d{1,24}$/.test(pin)) return toast("PIN must be 1-24 digits", "error");
        await withBusy(addUserBtn, async () => {
          try {
            const body = { name, privilege: privIn.value };
            if (cardIn.value.trim()) body.cardNo = cardIn.value.trim();
            if (pwIn.value) body.password = pwIn.value;
            const r = await api("PUT", `${devicePath(sn)}/users/${encodeURIComponent(pin)}`, body);
            toast(queuedMessage(r, `Save user ${pin}`), "ok");
            userForm.reset();
            pinIn.focus();
            await Promise.all([loadUsers(), loadCommands()]);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    },
    field("PIN", pinIn, "narrow"),
    field("Name", unameIn),
    field("Card number", cardIn),
    field("Privilege", privIn, "narrow"),
    field("Password", pwIn),
    h("div", { class: "actions" }, addUserBtn)
  );

  const csvIn = h("textarea", { name: "csv", rows: "5", spellcheck: "false", placeholder: "pin,name,cardNo,privilege\n1001,Jane Doe,,user\n1002,John Roe,123456,admin" });
  const importBtn = h("button", { type: "submit", class: "btn-primary", text: "Import" });
  const importResult = h("div", { class: "muted note", role: "status" });
  const importForm = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!csvIn.value.trim()) return toast("Paste some CSV rows first", "error");
        await withBusy(importBtn, async () => {
          try {
            const r = await api("POST", `${devicePath(sn)}/users/import`, { csv: csvIn.value });
            clear(importResult).append(`Imported ${plural(r.imported, "user")} (${plural(r.queued, "command")} queued).`);
            if (r.errors && r.errors.length) {
              const list = h("ul", {});
              r.errors.slice(0, 20).forEach((x) => list.append(h("li", { text: `Line ${x.line}: ${x.error}` })));
              importResult.append(` ${plural(r.errors.length, "row")} skipped:`, list);
              toast(`Imported ${r.imported}, skipped ${r.errors.length}`, "error");
            } else {
              csvIn.value = "";
              toast(`Imported ${plural(r.imported, "user")}`, "ok");
            }
            await Promise.all([loadUsers(), loadCommands()]);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    },
    field("CSV rows", csvIn, "full"),
    h("div", { class: "actions" }, importBtn)
  );

  panels.users.append(
    h(
      "div",
      { class: "card flush" },
      h("div", { class: "card-head" }, h("h2", { text: "Users on device" }), usersCount),
      tableWrap(["PIN", "Name", "Card", "Privilege", "Updated", h("th", { scope: "col", class: "num", "aria-label": "Actions" })], usersBody)
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Add or update user" }),
      h("p", { class: "muted mb-12", text: "The user is sent to the device as a command. Saving an existing PIN updates it. Enrol face or fingerprint on the device itself afterwards." }),
      userForm
    ),
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Import users from CSV" }),
      h("p", { class: "muted mb-12", text: "Columns: pin, name, cardNo, privilege (user or admin). A header row is optional. Up to 500 rows." }),
      importForm,
      importResult
    )
  );

  // Actions tab
  async function runAction(action, body, label) {
    try {
      const r = await api("POST", `${devicePath(sn)}/actions/${action}`, body);
      toast(queuedMessage(r, label), "ok");
      await loadCommands();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function actionCard(title, desc, ...controls) {
    return h("div", { class: "action" }, h("h3", { text: title }), h("p", { text: desc }), ...controls);
  }

  const fetchUsersBtn = h("button", { type: "button", text: "Fetch users" });
  fetchUsersBtn.addEventListener("click", () => withBusy(fetchUsersBtn, () => runAction("fetch-users", {}, "Fetch users")));

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 86400000);
  const fromIn = h("input", { type: "date", required: true, value: isoDate(weekAgo) });
  const toIn = h("input", { type: "date", required: true, value: isoDate(today) });
  const fetchAttBtn = h("button", { type: "submit", text: "Fetch attendance" });
  const attForm = h(
    "form",
    {
      class: "form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!fromIn.value || !toIn.value) return toast("Both dates are required", "error");
        if (fromIn.value > toIn.value) return toast("“From” must be before “To”", "error");
        withBusy(fetchAttBtn, () => runAction("fetch-attendance", { from: fromIn.value, to: toIn.value }, "Fetch attendance"));
      },
    },
    field("From", fromIn),
    field("To", toIn),
    h("div", { class: "actions" }, fetchAttBtn)
  );

  const actionList = h(
    "div",
    { class: "action-list" },
    actionCard("Fetch users", "Read the full user list from the device and update the Users tab (and the tenant's POS).", h("div", { class: "btn-row" }, fetchUsersBtn)),
    actionCard(
      "Fetch attendance",
      "Ask the device to re-send its stored attendance records for a date range. New records are stored and delivered to the tenant's POS as history; duplicates are ignored.",
      attForm
    )
  );

  if (isAcc) {
    const syncBtn = h("button", { type: "button", text: "Sync time" });
    syncBtn.addEventListener("click", () => withBusy(syncBtn, () => runAction("sync-time", {}, "Sync time")));
    const secIn = h("input", { type: "number", min: "1", max: "60", value: "5" });
    const doorBtn = h("button", { type: "submit", text: "Open door" });
    const doorForm = h(
      "form",
      {
        class: "form",
        onsubmit: (e) => {
          e.preventDefault();
          const seconds = Number(secIn.value);
          if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) return toast("Seconds must be between 1 and 60", "error");
          withBusy(doorBtn, () => runAction("open-door", { seconds }, "Open door"));
        },
      },
      field("Seconds", secIn, "narrow"),
      h("div", { class: "actions" }, doorBtn)
    );
    actionList.append(
      actionCard("Sync time", "Set the device clock to the server's time in the tenant's timezone.", h("div", { class: "btn-row" }, syncBtn)),
      actionCard("Open door", "Unlock door 1 remotely for a few seconds.", doorForm)
    );
  }

  actionList.append(
    actionCard(
      "Reboot",
      "Restart the device. It will be offline for about a minute.",
      h("div", { class: "btn-row" }, confirmButton("Reboot", { prompt: "Reboot now?", confirmLabel: "Reboot", onConfirm: () => runAction("reboot", {}, "Reboot") }))
    )
  );

  panels.actions.append(
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Device actions" }),
      actionList,
      isAcc ? null : h("p", { class: "muted note", text: "Sync time and Open door are available on access-control (acc) devices only." })
    )
  );

  // Commands tab
  const cmdBody = h("tbody", {}, emptyRow(8, "Loading…"));
  const cmdStatus = h("span", { class: "muted" });
  const refreshBtn = h("button", { type: "button", class: "btn-sm", text: "Refresh" });
  refreshBtn.addEventListener("click", () => withBusy(refreshBtn, loadCommands));
  let cmdTimer = null;
  let lastStatuses = new Map();

  async function loadCommands() {
    let rows;
    try {
      rows = await api("GET", `${devicePath(sn)}/commands?limit=50`);
    } catch (err) {
      if (token !== routeToken) return;
      clear(cmdBody).append(emptyRow(8, err.message));
      return;
    }
    if (token !== routeToken) return;

    // A finished fetch / user command changes the user list: reload it.
    let usersChanged = false;
    rows.forEach((c) => {
      const prev = lastStatuses.get(c.id);
      if (prev && prev !== c.status && (c.status === "success" || c.status === "failed")) {
        if (c.status === "success" && /user/i.test(c.kind)) usersChanged = true;
        if (c.status === "failed") toast(`Command #${c.id} (${c.kind || "command"}) failed${c.returnCode !== null && c.returnCode !== undefined ? ` with code ${c.returnCode}` : ""}`, "error");
      }
    });
    lastStatuses = new Map(rows.map((c) => [c.id, c.status]));
    if (usersChanged) loadUsers();

    clear(cmdBody);
    if (!rows.length) cmdBody.append(emptyRow(8, "No commands sent to this device yet."));
    rows.forEach((c) => {
      cmdBody.append(
        h(
          "tr",
          {},
          h("td", { class: "mono", text: String(c.id) }),
          h("td", {}, h("span", { class: `badge ${c.status}`, text: dash(c.status) })),
          h("td", { text: dash(c.kind) }),
          h("td", { class: "mono wrap", text: dash(c.command) }),
          h("td", { class: "mono", text: dash(c.returnCode) }),
          h("td", { class: "wrap", text: dash(c.result) }),
          h("td", { class: "muted", title: fmtTime(c.createdAt), text: c.createdAt ? relTime(c.createdAt) : "—" }),
          h("td", { class: "muted" }, c.completedAt ? `done ${relTime(c.completedAt)}` : c.sentAt ? `sent ${relTime(c.sentAt)}` : "waiting")
        )
      );
    });

    const active = rows.some((c) => c.status === "pending" || c.status === "sent");
    cmdStatus.textContent = active ? "Waiting for the device… refreshing every 3 s" : "";
    if (active && !cmdTimer) cmdTimer = every(COMMAND_POLL_MS, loadCommands);
    if (!active && cmdTimer) {
      stopTimer(cmdTimer);
      cmdTimer = null;
    }
  }

  panels.commands.append(
    h(
      "div",
      { class: "card flush" },
      h("div", { class: "card-head" }, h("h2", { text: "Command log" }), h("div", { class: "btn-row" }, cmdStatus, refreshBtn)),
      tableWrap(["ID", "Status", "Kind", "Command", "Return", "Result", "Created", "Progress"], cmdBody)
    )
  );

  await Promise.all([loadUsers(), loadCommands()]);

  // Keep online status fresh without disturbing the forms.
  every(ONLINE_POLL_MS, async () => {
    try {
      const d = await api("GET", devicePath(sn));
      if (token !== routeToken) return;
      device = { ...device, ...d };
      paintHead(device);
      paintInfo(device);
    } catch (err) {
      // transient; the next poll will retry
    }
  });
}

// ---------- tenants ----------

async function viewTenants(token) {
  clear(main);
  main.append(pageHead("Tenants", "One tenant per POS install. Each gets its own API key and receives punches from its devices."));
  const secretBox = h("div", {});
  const tbody = h("tbody", {}, emptyRow(7, "Loading…"));

  const nameIn = h("input", { required: true, maxlength: "100", autocomplete: "off", placeholder: "e.g. Acme Retail" });
  const urlIn = h("input", { type: "url", maxlength: "500", autocomplete: "off", placeholder: "https://acme.example.com/api" });
  const keyIn = h("input", { type: "password", maxlength: "500", autocomplete: "new-password", placeholder: "POS X-Authorization key" });
  const tzList = timezoneList();
  const tzIn = h("input", { maxlength: "64", autocomplete: "off", list: tzList.id, placeholder: "Server default" });
  const createBtn = h("button", { type: "submit", class: "btn-primary", text: "Create tenant" });
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameIn.value.trim();
        if (!name) return toast("Name is required", "error");
        const body = { name };
        if (urlIn.value.trim()) body.posApiUrl = urlIn.value.trim();
        if (keyIn.value) body.posKey = keyIn.value;
        if (tzIn.value.trim()) body.timezone = tzIn.value.trim();
        await withBusy(createBtn, async () => {
          try {
            const r = await api("POST", "/tenants", body);
            form.reset();
            clear(secretBox).append(secretPanel(r.apiKey, r.tenant.name));
            toast(`Tenant ${r.tenant.name} created`, "ok");
            await load();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    },
    field("Name", nameIn),
    field("POS API URL", urlIn),
    field("POS key", keyIn),
    field("Timezone", tzIn),
    tzList,
    h("div", { class: "actions" }, createBtn)
  );

  main.append(
    secretBox,
    h(
      "section",
      { class: "card flush", "aria-label": "Tenant list" },
      tableWrap(
        [
          "Name",
          "Status",
          "POS",
          "API key",
          "Timezone",
          h("th", { scope: "col", class: "num", text: "Devices" }),
          h("th", { scope: "col", class: "num", text: "Pending / failed" }),
        ],
        tbody
      )
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "add-tenant-h" },
      h("h2", { id: "add-tenant-h", text: "New tenant" }),
      h("p", { class: "muted mb-12", text: "The tenant's API key is shown once after creating it. The POS URL and key can be set later." }),
      form
    )
  );

  async function load() {
    try {
      const tenants = await loadTenants(true);
      if (token !== routeToken) return;
      clear(tbody);
      if (!tenants.length) tbody.append(emptyRow(7, "No tenants yet. Create one below."));
      tenants.forEach((t) => {
        const pos = t.posApiUrl && t.hasPosKey ? h("span", { class: "mono", text: t.posApiUrl }) : h("span", { class: "badge pending", text: t.posApiUrl ? "No POS key" : "Not configured" });
        tbody.append(
          h(
            "tr",
            {},
            h("td", {}, h("a", { href: `#${tenantPath(t.id)}`, class: "row-link", text: t.name })),
            h("td", {}, h("span", { class: `badge ${t.enabled ? "enabled" : "disabled"}`, text: t.enabled ? "Enabled" : "Disabled" })),
            h("td", {}, pos),
            h("td", { class: "mono", text: `${t.apiKeyPrefix}…` }),
            h("td", { text: t.timezone }),
            h("td", { class: "num", text: String(t.deviceCount || 0) }),
            h("td", { class: "num" }, String(t.pendingDeliveries || 0), " / ", h("span", { class: t.failedDeliveries ? "confirm-text" : undefined, text: String(t.failedDeliveries || 0) }))
          )
        );
      });
    } catch (err) {
      if (token !== routeToken) return;
      if (err.status === 503) return renderFatal(err);
      clear(tbody).append(emptyRow(7, err.message));
    }
  }
  await load();
}

async function viewTenant(token, id) {
  clear(main);
  main.append(h("p", { class: "spinner-text", text: "Loading tenant…" }));
  let tenant;
  try {
    tenant = await api("GET", tenantPath(id));
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 404) {
      clear(main);
      main.append(h("a", { class: "crumb", href: "#/tenants", text: "← Tenants" }), h("div", { class: "notice", text: "Tenant not found." }));
      return;
    }
    return renderFatal(err);
  }
  if (token !== routeToken) return;
  clear(main);

  const titleEl = h("h1", { text: tenant.name });
  const headSub = h("p", { class: "sub btn-row" });
  const secretBox = h("div", {});
  function paintHead() {
    titleEl.textContent = tenant.name;
    document.title = `${tenant.name} · ZKTeco Admin`;
    clear(headSub).append(
      h("span", { class: `badge ${tenant.enabled ? "enabled" : "disabled"}`, text: tenant.enabled ? "Enabled" : "Disabled" }),
      h("span", { class: "muted mono", text: `key ${tenant.apiKeyPrefix}…` })
    );
  }
  main.append(h("a", { class: "crumb", href: "#/tenants", text: "← Tenants" }), h("div", { class: "page-head" }, h("div", {}, titleEl, headSub)), secretBox);
  paintHead();

  // Edit form. The POS key is write-only: blank keeps the stored one.
  const nameIn = h("input", { required: true, maxlength: "100", autocomplete: "off" });
  const urlIn = h("input", { type: "url", maxlength: "500", autocomplete: "off", placeholder: "https://acme.example.com/api" });
  const keyIn = h("input", { type: "password", maxlength: "500", autocomplete: "new-password" });
  const tzList = timezoneList();
  const tzIn = h("input", { required: true, maxlength: "64", autocomplete: "off", list: tzList.id });
  const enabledIn = h("input", { type: "checkbox" });
  const saveBtn = h("button", { type: "submit", class: "btn-primary", text: "Save" });
  const clearKeyBox = h("span", {});
  function paintForm() {
    nameIn.value = tenant.name;
    urlIn.value = tenant.posApiUrl || "";
    keyIn.value = "";
    keyIn.placeholder = tenant.hasPosKey ? "Set (leave blank to keep)" : "Not set";
    tzIn.value = tenant.timezone;
    enabledIn.checked = tenant.enabled;
    clear(clearKeyBox);
    if (tenant.hasPosKey) {
      clearKeyBox.append(
        confirmButton("Remove POS key", {
          prompt: "Stop deliveries until a new key is set?",
          confirmLabel: "Remove",
          onConfirm: () => save({ posKey: null }, "POS key removed"),
        })
      );
    }
  }
  async function save(body, message) {
    try {
      tenant = await api("PATCH", tenantPath(id), body);
      paintHead();
      paintForm();
      toast(message, "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  }
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: (e) => {
        e.preventDefault();
        const body = { name: nameIn.value.trim(), posApiUrl: urlIn.value.trim() || null, timezone: tzIn.value.trim(), enabled: enabledIn.checked };
        if (keyIn.value) body.posKey = keyIn.value;
        withBusy(saveBtn, () => save(body, "Tenant saved"));
      },
    },
    field("Name", nameIn),
    field("POS API URL", urlIn),
    field("POS key", keyIn),
    field("Timezone", tzIn),
    tzList,
    h("div", { class: "field narrow" }, checkbox("Enabled", enabledIn)),
    h("div", { class: "actions btn-row" }, saveBtn, clearKeyBox)
  );
  paintForm();

  const testBtn = h("button", { type: "button", text: "Test connection" });
  const testResult = h("span", { class: "muted", role: "status" });
  testBtn.addEventListener("click", () =>
    withBusy(testBtn, async () => {
      testResult.textContent = "Testing…";
      try {
        const r = await api("POST", `${tenantPath(id)}/test`);
        const detail = [r.status ? `HTTP ${r.status}` : null, r.error].filter(Boolean).join(" · ");
        testResult.textContent = r.ok ? `OK${detail ? ` (${detail})` : ""}` : `Failed${detail ? `: ${detail}` : ""}`;
        toast(r.ok ? "POS accepted the test request" : `POS test failed${detail ? `: ${detail}` : ""}`, r.ok ? "ok" : "error");
      } catch (err) {
        testResult.textContent = "";
        toast(err.message, "error");
      }
    })
  );

  const rotateBox = confirmButton("Rotate API key", {
    prompt: "The old key stops working now.",
    confirmLabel: "Rotate",
    className: "",
    onConfirm: async () => {
      try {
        const r = await api("POST", `${tenantPath(id)}/rotate-key`);
        if (r.tenant) tenant = r.tenant;
        paintHead();
        clear(secretBox).append(secretPanel(r.apiKey, tenant.name));
        toast("API key rotated", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
    },
  });

  const deleteBox = confirmButton("Delete tenant", {
    prompt: "Delete this tenant?",
    confirmLabel: "Delete",
    onConfirm: async () => {
      try {
        await api("DELETE", tenantPath(id));
        toast(`Tenant ${tenant.name} deleted`, "ok");
        location.hash = "#/tenants";
      } catch (err) {
        toast(err.message, "error");
      }
    },
  });

  const devBody = h("tbody", {}, emptyRow(5, "Loading…"));
  main.append(
    h(
      "section",
      { class: "card", "aria-labelledby": "tenant-settings-h" },
      h("h2", { id: "tenant-settings-h", text: "Settings" }),
      h("p", { class: "muted mb-12", text: "Punches and device users are POSTed to {POS API URL}/attendance-api/v1/… with the POS key as X-Authorization." }),
      form,
      h("hr", { class: "sep" }),
      h("h2", { text: "Connection" }),
      h("div", { class: "btn-row" }, h("p", { class: "muted grow", text: "Sends an empty punches batch to the POS to check the URL and key." }), testResult, testBtn),
      h("hr", { class: "sep" }),
      h("h2", { text: "API key" }),
      h("div", { class: "btn-row" }, h("p", { class: "muted grow", text: "The POS calls this server with this key. Rotate it if it may have leaked; the new key is shown once." }), rotateBox),
      h("hr", { class: "sep" }),
      h("h2", { text: "Danger zone" }),
      h("div", { class: "btn-row" }, h("p", { class: "muted grow", text: "Its devices become unassigned and pending; their undelivered punches are held." }), deleteBox)
    ),
    h(
      "section",
      { class: "card flush", "aria-label": "Tenant devices" },
      h("div", { class: "card-head" }, h("h2", { text: "Devices" }), h("a", { href: `#/deliveries?tenantId=${encodeURIComponent(id)}`, text: "Deliveries →" })),
      tableWrap([h("th", { scope: "col", "aria-label": "Online" }), "Name", "Branch", "Access", "Last seen"], devBody)
    )
  );

  try {
    const devices = await api("GET", `/devices?tenantId=${encodeURIComponent(id)}`);
    if (token !== routeToken) return;
    clear(devBody);
    if (!devices.length) devBody.append(emptyRow(5, "No devices assigned. Assign one from its device page, or claim it from the POS."));
    devices.forEach((d) =>
      devBody.append(
        h(
          "tr",
          {},
          h("td", {}, statusDot(d.online)),
          h("td", {}, h("a", { href: `#${devicePath(d.sn)}`, class: "row-link", text: deviceLabel(d) })),
          h("td", { class: "mono", text: dash(d.branchId) }),
          h("td", {}, accessBadge(d.access)),
          h("td", { title: fmtTime(d.lastSeen), text: relTime(d.lastSeen) })
        )
      )
    );
  } catch (err) {
    if (token !== routeToken) return;
    clear(devBody).append(emptyRow(5, err.message));
  }
}

// ---------- attendance ----------

const DIRECTION_LABELS = { in: "Check-in", out: "Check-out" };

async function viewAttendance(token, params) {
  clear(main);
  main.append(pageHead("Attendance", "Punch records received from all devices, and their delivery to each POS."));

  const tenantSel = h("select", { name: "tenantId" }, h("option", { value: "", text: "All tenants" }));
  const deviceSel = h("select", { name: "sn" }, h("option", { value: "", text: "All devices" }));
  const pinIn = h("input", { name: "pin", autocomplete: "off", inputmode: "numeric", placeholder: "Any" });
  const fromIn = h("input", { name: "from", type: "date" });
  const toIn = h("input", { name: "to", type: "date" });
  const statusSel = h(
    "select",
    { name: "deliveryStatus" },
    h("option", { value: "", text: "Any" }),
    Object.entries(DELIVERY_LABELS).map(([value, text]) => h("option", { value, text }))
  );
  const initial = { tenantId: params.get("tenantId") || "", sn: params.get("sn") || "" };
  pinIn.value = params.get("pin") || "";
  fromIn.value = params.get("from") || "";
  toIn.value = params.get("to") || "";
  statusSel.value = params.get("deliveryStatus") || "";
  // Cursor paging: a stack of the cursors that led to each page, for "Newer".
  let cursors = [null];

  const csvLink = h("a", { class: "btn", download: "attendance.csv", text: "Export CSV" });
  const applyBtn = h("button", { type: "submit", class: "btn-primary", text: "Apply" });
  const resetBtn = h("button", {
    type: "button",
    text: "Reset",
    onclick: () => {
      [tenantSel, deviceSel, pinIn, fromIn, toIn, statusSel].forEach((el) => (el.value = ""));
      cursors = [null];
      load();
    },
  });
  const form = h(
    "form",
    {
      class: "form",
      onsubmit: (e) => {
        e.preventDefault();
        if (fromIn.value && toIn.value && fromIn.value > toIn.value) return toast("“From” must be before “To”", "error");
        cursors = [null];
        load();
      },
    },
    field("Tenant", tenantSel),
    field("Device", deviceSel),
    field("PIN", pinIn, "narrow"),
    field("From", fromIn),
    field("To", toIn),
    field("Delivery", statusSel, "narrow"),
    h("div", { class: "actions btn-row" }, applyBtn, resetBtn, csvLink)
  );

  const tbody = h("tbody", {}, emptyRow(7, "Loading…"));
  const summary = h("span", { class: "muted" });
  const prevBtn = h("button", { type: "button", class: "btn-sm", text: "← Newer" });
  const nextBtn = h("button", { type: "button", class: "btn-sm", text: "Older →" });
  let nextCursor = null;
  prevBtn.addEventListener("click", () => {
    if (cursors.length > 1) cursors.pop();
    load();
  });
  nextBtn.addEventListener("click", () => {
    if (!nextCursor) return;
    cursors.push(nextCursor);
    load();
  });

  main.append(
    h("section", { class: "card", "aria-label": "Filters" }, form),
    h(
      "section",
      { class: "card flush", "aria-label": "Attendance records" },
      tableWrap(["PIN", "Name", "Time", "Direction", "Verify", "Device", "Delivery"], tbody),
      h("div", { class: "pager" }, summary, h("div", { class: "btn-row" }, prevBtn, nextBtn))
    )
  );

  const deviceNames = new Map();
  const userCache = new Map();

  try {
    const [tenants, devices] = await Promise.all([loadTenants(true), api("GET", "/devices")]);
    if (token !== routeToken) return;
    tenantOptions(tenantSel, tenants, { allLabel: "All tenants", selected: initial.tenantId });
    devices.forEach((d) => {
      deviceNames.set(d.sn, deviceLabel(d));
      deviceSel.append(h("option", { value: d.sn, text: d.name ? `${d.name} (${d.sn})` : d.sn }));
    });
    if (initial.sn && !devices.some((d) => d.sn === initial.sn)) deviceSel.append(h("option", { value: initial.sn, text: initial.sn }));
    deviceSel.value = initial.sn;
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 503) return renderFatal(err);
    toast(err.message, "error");
    if (initial.sn) {
      deviceSel.append(h("option", { value: initial.sn, text: initial.sn }));
      deviceSel.value = initial.sn;
    }
  }

  function filters() {
    const q = new URLSearchParams();
    if (tenantSel.value) q.set("tenantId", tenantSel.value);
    if (deviceSel.value) q.set("sn", deviceSel.value);
    if (pinIn.value.trim()) q.set("pin", pinIn.value.trim());
    if (fromIn.value) q.set("from", fromIn.value);
    if (toIn.value) q.set("to", toIn.value);
    if (statusSel.value) q.set("deliveryStatus", statusSel.value);
    return q;
  }

  async function usersFor(sn) {
    if (!userCache.has(sn)) {
      userCache.set(
        sn,
        api("GET", `${devicePath(sn)}/users`)
          .then((users) => new Map(users.map((u) => [String(u.pin), u.name])))
          .catch(() => new Map())
      );
    }
    return userCache.get(sn);
  }

  function deliveryCell(p) {
    const title = p.lastError
      ? `${p.lastError} (${plural(p.attempts, "attempt")})`
      : p.deliveredAt
        ? `Delivered ${fmtTime(p.deliveredAt)}`
        : p.deliveryStatus === "held"
          ? "Device has no tenant yet"
          : p.attempts
            ? plural(p.attempts, "attempt")
            : "";
    return h("td", {}, deliveryBadge(p.deliveryStatus, title));
  }

  async function load() {
    const q = filters();
    csvLink.href = `${API}/attendance.csv${q.toString() ? `?${q}` : ""}`;
    history.replaceState(null, "", `#/attendance${q.toString() ? `?${q}` : ""}`);
    const cursor = cursors[cursors.length - 1];
    q.set("limit", String(PAGE_SIZE));
    if (cursor) q.set("cursor", cursor);
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    try {
      const r = await api("GET", `/attendance?${q}`);
      if (token !== routeToken) return;
      const rows = r.punches || [];
      nextCursor = r.nextCursor || null;
      const sns = [...new Set(rows.map((p) => p.sn).filter(Boolean))];
      const maps = new Map(await Promise.all(sns.map(async (sn) => [sn, await usersFor(sn)])));
      if (token !== routeToken) return;
      clear(tbody);
      if (!rows.length) tbody.append(emptyRow(7, "No attendance records match these filters."));
      rows.forEach((p) => {
        const names = maps.get(p.sn);
        const name = names && names.get(String(p.pin));
        const dir = DIRECTION_LABELS[p.direction];
        tbody.append(
          h(
            "tr",
            {},
            h("td", { class: "mono", text: dash(p.pin) }),
            h("td", { class: name ? undefined : "muted", text: dash(name) }),
            h("td", { class: "mono", title: `${p.timezone} · ${p.punchedAtUtc}`, text: dash(p.punchedAt) }),
            h("td", {}, dir ? h("span", { class: `badge ${p.direction}`, text: dir }) : "—"),
            h("td", { text: dash(p.verifyMode) }),
            h("td", { title: p.sn || "", text: dash(p.deviceName || deviceNames.get(p.sn) || p.sn) }),
            deliveryCell(p)
          )
        );
      });
      const page = cursors.length;
      summary.textContent = rows.length ? `Page ${page} · ${plural(rows.length, "record")}` : "0 records";
      prevBtn.disabled = page === 1;
      nextBtn.disabled = !nextCursor;
    } catch (err) {
      if (token !== routeToken) return;
      if (err.status === 503) return renderFatal(err);
      clear(tbody).append(emptyRow(7, err.message));
      summary.textContent = "";
      toast(err.message, "error");
    }
  }

  await load();
}

// ---------- deliveries ----------

async function viewDeliveries(token, params) {
  clear(main);
  main.append(pageHead("Deliveries", "Punch and device-user webhooks to each POS. Failed deliveries can be queued again."));

  const tenantSel = h("select", { name: "tenantId" }, h("option", { value: "", text: "All tenants" }));
  const initialTenant = params.get("tenantId") || "";
  const tiles = h("div", { class: "tiles", role: "group", "aria-label": "Punch delivery counts" });
  const punchBody = h("tbody", {}, emptyRow(6, "Loading…"));
  const outboxBody = h("tbody", {}, emptyRow(6, "Loading…"));

  // Requeue form
  const retryTenant = h("select", { required: true });
  const today = new Date();
  const rFrom = h("input", { type: "date", required: true, value: isoDate(new Date(today.getTime() - 2 * 86400000)) });
  const rTo = h("input", { type: "date", required: true, value: isoDate(today) });
  const rSn = h("input", { maxlength: "64", autocomplete: "off", placeholder: "All devices" });
  const rFailed = h("input", { type: "checkbox", checked: true });
  const retryBtn = h("button", { type: "submit", class: "btn-primary", text: "Queue again" });
  const retryForm = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!retryTenant.value) return toast("Choose a tenant", "error");
        if (!rFrom.value || !rTo.value) return toast("Both dates are required", "error");
        if (rFrom.value > rTo.value) return toast("“From” must be before “To”", "error");
        const body = { tenantId: retryTenant.value, from: rFrom.value, to: rTo.value, failedOnly: rFailed.checked };
        if (rSn.value.trim()) body.sn = rSn.value.trim();
        await withBusy(retryBtn, async () => {
          try {
            const r = await api("POST", "/deliveries/retry", body);
            toast(`Queued ${plural(r.requeued, "punch")} for delivery`, "ok");
            await load();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    },
    field("Tenant", retryTenant),
    field("From", rFrom),
    field("To", rTo),
    field("Device serial", rSn),
    h("div", { class: "field narrow" }, checkbox("Failed only", rFailed)),
    h("div", { class: "actions" }, retryBtn)
  );

  main.append(
    h("section", { class: "card", "aria-label": "Filters" }, h("div", { class: "form" }, field("Tenant", tenantSel))),
    tiles,
    h(
      "section",
      { class: "card flush", "aria-label": "Failed punches" },
      h("div", { class: "card-head" }, h("h2", { text: "Recent failed punches" }), h("a", { id: "failed-link", href: "#/attendance?deliveryStatus=failed", text: "All failed →" })),
      tableWrap(["Tenant", "Device", "PIN", "Time", "Attempts", "Error"], punchBody)
    ),
    h(
      "section",
      { class: "card flush", "aria-label": "Failed device-user webhooks" },
      h("div", { class: "card-head" }, h("h2", { text: "Failed device-user webhooks" })),
      tableWrap(["ID", "Tenant", "Created", "Attempts", "Error", h("th", { scope: "col", class: "num", "aria-label": "Actions" })], outboxBody)
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "retry-h" },
      h("h2", { id: "retry-h", text: "Redeliver punches" }),
      h("p", { class: "muted mb-12", text: "Queues punches in a date range for delivery again. The POS ignores duplicates by eventId. Untick “Failed only” to resend delivered punches too." }),
      retryForm
    )
  );

  let tenantNames = new Map();
  try {
    const tenants = await loadTenants(true);
    if (token !== routeToken) return;
    tenantNames = new Map(tenants.map((t) => [t.id, t.name]));
    tenantOptions(tenantSel, tenants, { allLabel: "All tenants", selected: initialTenant });
    tenantOptions(retryTenant, tenants, { allLabel: "Choose…", selected: initialTenant });
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 503) return renderFatal(err);
    toast(err.message, "error");
  }
  tenantSel.addEventListener("change", () => {
    if (tenantSel.value) retryTenant.value = tenantSel.value;
    load();
  });

  const tenantCell = (id) => h("td", {}, id ? h("a", { href: `#${tenantPath(id)}`, text: tenantNames.get(id) || id }) : "—");

  async function load() {
    const q = tenantSel.value ? `?tenantId=${encodeURIComponent(tenantSel.value)}` : "";
    history.replaceState(null, "", `#/deliveries${q}`);
    const link = document.getElementById("failed-link");
    if (link) link.href = `#/attendance?deliveryStatus=failed${tenantSel.value ? `&tenantId=${encodeURIComponent(tenantSel.value)}` : ""}`;
    try {
      const r = await api("GET", `/deliveries${q}`);
      if (token !== routeToken) return;
      const counts = r.counts || {};
      clear(tiles);
      Object.entries(DELIVERY_LABELS).forEach(([key, label]) =>
        tiles.append(h("div", { class: `tile ${key}` }, h("div", { class: "label", text: label }), h("div", { class: "value", text: String(counts[key] || 0) })))
      );

      clear(punchBody);
      const punches = r.failedPunches || [];
      if (!punches.length) punchBody.append(emptyRow(6, "No failed punches."));
      punches.forEach((p) =>
        punchBody.append(
          h(
            "tr",
            {},
            tenantCell(p.tenantId),
            h("td", { title: p.sn, text: dash(p.deviceName || p.sn) }),
            h("td", { class: "mono", text: p.pin }),
            h("td", { class: "mono", text: p.punchedAt }),
            h("td", { class: "num", text: String(p.attempts) }),
            h("td", { class: "wrap", text: dash(p.lastError) })
          )
        )
      );

      clear(outboxBody);
      const rows = r.failedOutbox || [];
      if (!rows.length) outboxBody.append(emptyRow(6, "No failed webhooks."));
      rows.forEach((o) => {
        const btn = h("button", { type: "button", class: "btn-sm", text: "Retry" });
        btn.addEventListener("click", () =>
          withBusy(btn, async () => {
            try {
              await api("POST", `/outbox/${o.id}/retry`);
              toast(`Webhook #${o.id} queued again`, "ok");
              await load();
            } catch (err) {
              toast(err.message, "error");
            }
          })
        );
        outboxBody.append(
          h(
            "tr",
            {},
            h("td", { class: "mono", text: String(o.id) }),
            tenantCell(o.tenantId),
            h("td", { class: "muted", title: fmtTime(o.createdAt), text: relTime(o.createdAt) }),
            h("td", { class: "num", text: String(o.attempts) }),
            h("td", { class: "wrap", text: dash(o.lastError) }),
            h("td", { class: "num" }, btn)
          )
        );
      });
    } catch (err) {
      if (token !== routeToken) return;
      if (err.status === 503) return renderFatal(err);
      toast(err.message, "error");
    }
  }

  await load();
  every(ONLINE_POLL_MS * 3, load);
}

// ---------- router ----------

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/devices";
  const [path, query] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(query || "") };
}

async function route() {
  clearTimers();
  const token = ++routeToken;
  const { parts, params } = parseHash();
  const section = parts[0] || "devices";

  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active = a.dataset.nav === section;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  try {
    if (section === "devices" && parts[1]) {
      const sn = decodeURIComponent(parts[1]);
      document.title = `${sn} · ZKTeco Admin`;
      await viewDevice(token, sn, params.get("tab"));
    } else if (section === "tenants" && parts[1]) {
      document.title = "Tenant · ZKTeco Admin";
      await viewTenant(token, decodeURIComponent(parts[1]));
    } else if (section === "tenants") {
      document.title = "Tenants · ZKTeco Admin";
      await viewTenants(token);
    } else if (section === "attendance") {
      document.title = "Attendance · ZKTeco Admin";
      await viewAttendance(token, params);
    } else if (section === "deliveries") {
      document.title = "Deliveries · ZKTeco Admin";
      await viewDeliveries(token, params);
    } else {
      document.title = "Devices · ZKTeco Admin";
      await viewDevices(token, params);
    }
  } catch (err) {
    if (token === routeToken) renderFatal(err);
  }
}

window.addEventListener("hashchange", () => {
  route();
  main.focus({ preventScroll: true });
});
route();
