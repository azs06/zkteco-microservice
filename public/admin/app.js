// Admin UI for the ZKTeco microservice. Every device-provided string is
// rendered via textContent (see h()); never use innerHTML with API data.

const API = "/api/admin";
const ONLINE_POLL_MS = 10000;
const COMMAND_POLL_MS = 3000;
const PAGE_SIZE = 50;

const main = document.getElementById("main");
const toastBox = document.getElementById("toasts");

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

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const opts = { method, headers: { Accept: "application/json" }, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
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
  if (!res.ok) {
    const message = (data && data.message) || `Request failed (${res.status})`;
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

function devicePath(sn) {
  return `/devices/${encodeURIComponent(sn)}`;
}

function deviceLabel(d) {
  return d.name || d.sn;
}

function queuedMessage(result, what) {
  const n = result && Array.isArray(result.commands) ? result.commands.length : 0;
  return `${what}: queued ${n} command${n === 1 ? "" : "s"}. The device runs them on its next poll.`;
}

const ACCESS_LABELS = {
  approved: "Approved",
  allowlist: "Allowlist",
  "user-agent": "User agent",
  pending: "Pending",
};

function accessBadge(access) {
  const key = ACCESS_LABELS[access] ? access : "pending";
  return h("span", { class: `badge ${key}`, text: ACCESS_LABELS[key] });
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

function renderFatal(err) {
  clear(main);
  if (err.status === 503) {
    main.append(h("div", { class: "notice" }, h("strong", { text: "Admin UI unavailable. " }), err.message));
  } else {
    main.append(h("div", { class: "notice" }, h("strong", { text: "Something went wrong. " }), err.message));
  }
}

// ---------- devices list ----------

async function viewDevices(token) {
  clear(main);
  main.append(
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", { text: "Devices" }), h("p", { class: "sub", text: "Devices that have contacted this server, and devices you have added." }))
    )
  );

  const tbody = h("tbody", {}, emptyRow(9, "Loading…"));
  const listCard = h(
    "section",
    { class: "card flush", "aria-label": "Device list" },
    tableWrap([h("th", { scope: "col", "aria-label": "Status" }), "Name", "Access", "Last seen", "Serial", "Type", "Firmware", "IP", h("th", { scope: "col", class: "num", text: "Users" })], tbody)
  );

  const snInput = h("input", { name: "sn", required: true, autocomplete: "off", placeholder: "e.g. NYU7254701889", maxlength: "64" });
  const nameInput = h("input", { name: "name", autocomplete: "off", placeholder: "e.g. Front door", maxlength: "100" });
  const addBtn = h("button", { type: "submit", class: "btn-primary", text: "Add device" });
  const form = h(
    "form",
    { class: "form", onsubmit: (e) => onAdd(e) },
    field("Serial number", snInput),
    field("Name", nameInput),
    h("div", { class: "actions" }, addBtn)
  );
  const addCard = h(
    "section",
    { class: "card", "aria-labelledby": "add-device-h" },
    h("h2", { id: "add-device-h", text: "Add device" }),
    h("p", { class: "muted", style: "margin:0 0 12px", text: "Pre-approve a device by its serial number. It is accepted as soon as it connects." }),
    form
  );
  main.append(listCard, addCard);

  async function onAdd(e) {
    e.preventDefault();
    const sn = snInput.value.trim();
    if (!sn) return toast("Serial number is required", "error");
    await withBusy(addBtn, async () => {
      try {
        await api("POST", "/devices", { sn, name: nameInput.value.trim() });
        toast(`Device ${sn} added and approved`, "ok");
        form.reset();
        await load();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  async function approve(d, btn) {
    await withBusy(btn, async () => {
      try {
        await api("PATCH", devicePath(d.sn), { approved: true });
        toast(`${deviceLabel(d)} approved`, "ok");
        await load();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  function row(d) {
    const link = h("a", { href: `#${devicePath(d.sn)}`, class: "row-link", text: d.name || d.sn });
    const access = h("td", {}, accessBadge(d.access));
    if (d.access === "pending") {
      const btn = h("button", { type: "button", class: "btn-sm btn-primary", text: "Approve", style: "margin-left:8px" });
      btn.addEventListener("click", () => approve(d, btn));
      access.append(btn);
    }
    return h(
      "tr",
      {},
      h("td", {}, statusDot(d.online)),
      h("td", {}, link),
      access,
      h("td", { title: fmtTime(d.lastSeen), text: relTime(d.lastSeen) }),
      h("td", { class: "mono", text: d.sn }),
      h("td", { text: typeLabel(d.deviceType) }),
      h("td", { class: "mono", text: dash(d.firmware) }),
      h("td", { class: "mono", text: dash(d.ip) }),
      h("td", { class: "num", text: String(d.userCount || 0) })
    );
  }

  let failed = false;
  async function load() {
    try {
      const devices = await api("GET", "/devices");
      if (token !== routeToken) return;
      failed = false;
      clear(tbody);
      if (!devices || !devices.length) {
        tbody.append(emptyRow(9, "No devices yet. Point a device at this server, or add one below."));
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
  try {
    device = await api("GET", devicePath(sn));
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 404) {
      clear(main);
      main.append(
        h("a", { class: "crumb", href: "#/devices", text: "← Devices" }),
        h("div", { class: "notice", text: `Device ${sn} was not found.` })
      );
      return;
    }
    return renderFatal(err);
  }
  if (token !== routeToken) return;

  const isAcc = device.deviceType === "acc";
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
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        {},
        titleEl,
        h("p", { class: "sub btn-row" }, headDot, headSeen, headAccess)
      )
    )
  );
  paintHead(device);

  // Info + settings
  const infoList = h("dl", { class: "kv" });
  const rawInfo = h("details", { class: "raw" });
  function paintInfo(d) {
    clear(infoList);
    const items = [
      ["Serial", d.sn],
      ["Type", typeLabel(d.deviceType)],
      ["Firmware", dash(d.firmware)],
      ["Push version", dash(d.pushVersion)],
      ["IP address", dash(d.ip)],
      ["User agent", dash(d.userAgent)],
      ["Last seen", d.lastSeen ? fmtTime(d.lastSeen) : "never"],
      ["Added", d.createdAt ? fmtTime(d.createdAt) : "—"],
      ["Users", String(d.userCount || 0)],
    ];
    items.forEach(([k, v]) => infoList.append(h("dt", { text: k }), h("dd", { class: k === "Serial" || k === "IP address" ? "mono" : undefined, text: v })));
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

  const nameInput = h("input", { value: device.name || "", maxlength: "100", autocomplete: "off", placeholder: device.sn });
  const saveBtn = h("button", { type: "submit", class: "btn-primary", text: "Save" });
  const nameForm = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(saveBtn, async () => {
          try {
            device = { ...device, ...(await api("PATCH", devicePath(sn), { name: nameInput.value.trim() })) };
            paintHead(device);
            paintInfo(device);
            toast("Name saved", "ok");
          } catch (err) {
            toast(err.message, "error");
          }
        });
      },
    },
    field("Display name", nameInput),
    h("div", { class: "actions" }, saveBtn)
  );

  const approvalBox = h("div", { class: "btn-row" });
  function paintApproval() {
    clear(approvalBox);
    const desc = device.approved
      ? "This device is approved and may push data to the server."
      : device.access === "allowlist"
        ? "Admitted through ALLOWED_SERIALS. Approve it here to keep access if the allowlist changes."
        : device.access === "user-agent"
          ? "Admitted through the ALLOWED_AGENT user-agent rule."
          : "This device is waiting for approval. Its requests are rejected until you approve it.";
    approvalBox.append(h("p", { class: "muted", style: "margin:0;flex:1 1 220px", text: desc }));
    if (device.approved) {
      approvalBox.append(
        confirmButton("Revoke approval", {
          prompt: "Revoke?",
          confirmLabel: "Revoke",
          onConfirm: () => setApproved(false),
        })
      );
    } else {
      const btn = h("button", { type: "button", class: "btn-primary", text: "Approve device" });
      btn.addEventListener("click", () => withBusy(btn, () => setApproved(true)));
      approvalBox.append(btn);
    }
  }
  async function setApproved(approved) {
    try {
      device = { ...device, ...(await api("PATCH", devicePath(sn), { approved })) };
      paintHead(device);
      paintApproval();
      toast(approved ? "Device approved" : "Approval revoked", "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  }
  paintApproval();

  const deleteBox = h(
    "div",
    { class: "btn-row" },
    h("p", { class: "muted", style: "margin:0;flex:1 1 220px", text: "Removes the device, its synced user list and command history from this server. Attendance records are kept." }),
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
        h("hr", { style: "border:none;border-top:1px solid var(--border);margin:16px 0" }),
        h("h2", { text: "Access" }),
        approvalBox,
        h("hr", { style: "border:none;border-top:1px solid var(--border);margin:16px 0" }),
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
    const btn = h("button", {
      type: "button",
      role: "tab",
      id: `tab-${key}`,
      "aria-controls": `panel-${key}`,
      "aria-selected": String(key === tab),
      text: label,
      onclick: () => selectTab(key),
    });
    tabBar.append(btn);
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
      document.getElementById(`tab-${k}`).setAttribute("aria-selected", String(k === key));
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
      usersCount.textContent = `${users.length} user${users.length === 1 ? "" : "s"}`;
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

  const pinIn = h("input", { name: "pin", required: true, inputmode: "numeric", autocomplete: "off", maxlength: "24", placeholder: "e.g. 1001" });
  const unameIn = h("input", { name: "name", required: true, autocomplete: "off", maxlength: "24", placeholder: "Full name" });
  const cardIn = h("input", { name: "cardNo", autocomplete: "off", inputmode: "numeric", maxlength: "20", placeholder: "Optional" });
  // 14 is the ZKTeco admin/superuser privilege level; 0 is a normal user.
  const privIn = h("select", { name: "privilege" }, h("option", { value: "0", text: "User" }), h("option", { value: "14", text: "Admin" }));
  const pwIn = h("input", { name: "password", type: "password", autocomplete: "new-password", maxlength: "8", placeholder: "Optional" });
  const addUserBtn = h("button", { type: "submit", class: "btn-primary", text: "Add user" });
  const userForm = h(
    "form",
    {
      class: "form",
      onsubmit: async (e) => {
        e.preventDefault();
        const pin = pinIn.value.trim();
        const name = unameIn.value.trim();
        if (!pin || !name) return toast("PIN and name are required", "error");
        await withBusy(addUserBtn, async () => {
          try {
            const body = { pin, name, privilege: Number(privIn.value) };
            if (cardIn.value.trim()) body.cardNo = cardIn.value.trim();
            if (pwIn.value) body.password = pwIn.value;
            const r = await api("POST", `${devicePath(sn)}/users`, body);
            toast(queuedMessage(r, `Add user ${pin}`), "ok");
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
      h("p", { class: "muted", style: "margin:0 0 12px", text: "The user is sent to the device as a command. Enrol face or fingerprint on the device itself afterwards." }),
      userForm
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
  const fromIn = h("input", { type: "date", value: isoDate(weekAgo) });
  const toIn = h("input", { type: "date", value: isoDate(today) });
  const fetchAttBtn = h("button", { type: "submit", text: "Fetch attendance" });
  const attForm = h(
    "form",
    {
      class: "form",
      onsubmit: (e) => {
        e.preventDefault();
        if (fromIn.value && toIn.value && fromIn.value > toIn.value) return toast("“From” must be before “To”", "error");
        withBusy(fetchAttBtn, () => runAction("fetch-attendance", { from: fromIn.value || undefined, to: toIn.value || undefined }, "Fetch attendance"));
      },
    },
    field("From", fromIn),
    field("To", toIn),
    h("div", { class: "actions" }, fetchAttBtn)
  );

  const actionList = h(
    "div",
    { class: "action-list" },
    actionCard("Fetch users", "Read the full user list from the device and update the Users tab.", h("div", { class: "btn-row" }, fetchUsersBtn)),
    actionCard("Fetch attendance", "Ask the device to re-send its stored attendance records for a date range (both dates required; long ranges are fetched month by month). Fetched records are stored but not forwarded to the HR API. The date filter is not yet verified on every firmware.", attForm)
  );

  if (isAcc) {
    const syncBtn = h("button", { type: "button", text: "Sync time" });
    syncBtn.addEventListener("click", () =>
      withBusy(syncBtn, () => runAction("sync-time", { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }, "Sync time"))
    );
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
      actionCard("Sync time", "Set the device clock to the server's current time.", h("div", { class: "btn-row" }, syncBtn)),
      actionCard("Open door", "Unlock door 1 remotely for a few seconds.", doorForm)
    );
  }

  actionList.append(
    actionCard(
      "Reboot",
      "Restart the device. It will be offline for about a minute.",
      h(
        "div",
        { class: "btn-row" },
        confirmButton("Reboot", {
          prompt: "Reboot now?",
          confirmLabel: "Reboot",
          onConfirm: () => runAction("reboot", {}, "Reboot"),
        })
      )
    )
  );

  panels.actions.append(
    h("div", { class: "card" }, h("h2", { text: "Device actions" }), actionList, isAcc ? null : h("p", { class: "muted", style: "margin:12px 0 0;font-size:13px", text: "Sync time and Open door are available on access-control (acc) devices only." }))
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
        if (c.status === "success" && /user/i.test(`${c.kind} ${c.command}`)) usersChanged = true;
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
          h(
            "td",
            { class: "muted" },
            c.completedAt ? `done ${relTime(c.completedAt)}` : c.sentAt ? `sent ${relTime(c.sentAt)}` : "waiting"
          )
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

// ---------- attendance ----------

const STATE_LABELS = { 0: "Check-in", 1: "Check-out" };

async function viewAttendance(token, params) {
  clear(main);
  main.append(
    h(
      "div",
      { class: "page-head" },
      h("div", {}, h("h1", { text: "Attendance" }), h("p", { class: "sub", text: "Punch records received from all devices." }))
    )
  );

  const deviceSel = h("select", { name: "sn" }, h("option", { value: "", text: "All devices" }));
  const pinIn = h("input", { name: "pin", autocomplete: "off", inputmode: "numeric", placeholder: "Any" });
  const fromIn = h("input", { name: "from", type: "date" });
  const toIn = h("input", { name: "to", type: "date" });
  const initialSn = params.get("sn") || "";
  pinIn.value = params.get("pin") || "";
  fromIn.value = params.get("from") || "";
  toIn.value = params.get("to") || "";
  let offset = Math.max(0, Number(params.get("offset")) || 0);

  const csvLink = h("a", { class: "btn", download: "attendance.csv", text: "Export CSV" });
  const applyBtn = h("button", { type: "submit", class: "btn-primary", text: "Apply" });
  const resetBtn = h("button", {
    type: "button",
    text: "Reset",
    onclick: () => {
      deviceSel.value = "";
      pinIn.value = "";
      fromIn.value = "";
      toIn.value = "";
      offset = 0;
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
        offset = 0;
        load();
      },
    },
    field("Device", deviceSel),
    field("PIN", pinIn, "narrow"),
    field("From", fromIn),
    field("To", toIn),
    h("div", { class: "actions btn-row" }, applyBtn, resetBtn, csvLink)
  );

  const tbody = h("tbody", {}, emptyRow(5, "Loading…"));
  const summary = h("span", { class: "muted" });
  const prevBtn = h("button", { type: "button", class: "btn-sm", text: "← Newer" });
  const nextBtn = h("button", { type: "button", class: "btn-sm", text: "Older →" });
  prevBtn.addEventListener("click", () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    load();
  });
  nextBtn.addEventListener("click", () => {
    offset += PAGE_SIZE;
    load();
  });

  main.append(
    h("section", { class: "card", "aria-label": "Filters" }, form),
    h(
      "section",
      { class: "card flush", "aria-label": "Attendance records" },
      tableWrap(["PIN", "Name", "Time", "State", "Device"], tbody),
      h("div", { class: "pager" }, summary, h("div", { class: "btn-row" }, prevBtn, nextBtn))
    )
  );

  const deviceNames = new Map();
  const userCache = new Map();

  try {
    const devices = await api("GET", "/devices");
    if (token !== routeToken) return;
    const selected = initialSn;
    devices.forEach((d) => {
      deviceNames.set(d.sn, deviceLabel(d));
      deviceSel.append(h("option", { value: d.sn, text: d.name ? `${d.name} (${d.sn})` : d.sn }));
    });
    if (selected && !devices.some((d) => d.sn === selected)) deviceSel.append(h("option", { value: selected, text: selected }));
    deviceSel.value = selected;
  } catch (err) {
    if (err.status === 503) return renderFatal(err);
    toast(err.message, "error");
    if (initialSn) {
      deviceSel.append(h("option", { value: initialSn, text: initialSn }));
      deviceSel.value = initialSn;
    }
  }

  function filters() {
    const q = new URLSearchParams();
    if (deviceSel.value) q.set("sn", deviceSel.value);
    if (pinIn.value.trim()) q.set("pin", pinIn.value.trim());
    if (fromIn.value) q.set("from", fromIn.value);
    if (toIn.value) q.set("to", toIn.value);
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

  async function load() {
    const q = filters();
    csvLink.href = `${API}/attendance.csv${q.toString() ? `?${q}` : ""}`;
    const pageQ = new URLSearchParams(q);
    if (offset) pageQ.set("offset", String(offset));
    history.replaceState(null, "", `#/attendance${pageQ.toString() ? `?${pageQ}` : ""}`);
    q.set("limit", String(PAGE_SIZE));
    q.set("offset", String(offset));
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    try {
      const { rows, total } = await api("GET", `/attendance?${q}`);
      if (token !== routeToken) return;
      const sns = [...new Set(rows.map((r) => r.deviceSN).filter(Boolean))];
      const maps = new Map(await Promise.all(sns.map(async (sn) => [sn, await usersFor(sn)])));
      if (token !== routeToken) return;
      clear(tbody);
      if (!rows.length) tbody.append(emptyRow(5, "No attendance records match these filters."));
      rows.forEach((r) => {
        const names = maps.get(r.deviceSN);
        const name = names && names.get(String(r.pin));
        const state = STATE_LABELS[r.stateId];
        tbody.append(
          h(
            "tr",
            {},
            h("td", { class: "mono", text: dash(r.pin) }),
            h("td", { class: name ? undefined : "muted", text: dash(name) }),
            h("td", { class: "mono", text: dash(r.activityTime) }),
            h("td", {}, state ? h("span", { class: `badge ${r.stateId === 0 || r.stateId === "0" ? "approved" : "sent"}`, text: state }) : "—"),
            h("td", { title: r.deviceSN || "", text: dash(deviceNames.get(r.deviceSN) || r.deviceSN) })
          )
        );
      });
      const start = total ? offset + 1 : 0;
      const end = offset + rows.length;
      summary.textContent = total ? `Showing ${start}–${end} of ${total}` : "0 records";
      prevBtn.disabled = offset === 0;
      nextBtn.disabled = end >= total;
    } catch (err) {
      if (token !== routeToken) return;
      if (err.status === 503) return renderFatal(err);
      clear(tbody).append(emptyRow(5, err.message));
      summary.textContent = "";
      toast(err.message, "error");
    }
  }

  await load();
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
    } else if (section === "attendance") {
      document.title = "Attendance · ZKTeco Admin";
      await viewAttendance(token, params);
    } else {
      document.title = "Devices · ZKTeco Admin";
      await viewDevices(token);
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
