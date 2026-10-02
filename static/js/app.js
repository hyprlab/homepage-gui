/* Homepage GUI — drag-and-drop editor for services.yaml */
(() => {
  "use strict";

  const COMMON = ["icon", "href", "description", "ping"];

  // ---- State ----
  let state = { groups: [] };
  let dirty = false;
  let uidCounter = 0;
  const groupById = new Map();
  const serviceById = new Map();

  let editing = null; // { group, service, isNew }
  let iconTarget = "field"; // where chosen icon goes (the editor field)

  const uid = (p) => `${p}${++uidCounter}`;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Every same-origin write carries the session CSRF token, and an expired
  // session bounces to the login page instead of failing silently.
  const CSRF = document.querySelector('meta[name="csrf"]')?.content || "";
  const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
  let redirectingToLogin = false;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input.url,
      window.location.href
    );
    const sameOrigin = url.origin === window.location.origin;
    const method = (
      (init && init.method) || (typeof input !== "string" && input.method) || "GET"
    ).toUpperCase();

    if (sameOrigin && CSRF && !SAFE_METHODS.includes(method)) {
      const headers = new Headers(
        (init && init.headers) || (typeof input !== "string" ? input.headers : undefined)
      );
      headers.set("X-CSRF", CSRF);
      init = { ...(init || {}), headers };
    }

    const res = await nativeFetch(input, init);
    if (res.status === 401 && sameOrigin && !redirectingToLogin) {
      redirectingToLogin = true;
      toast("Session expired — signing you in again…", "err");
      setTimeout(() => {
        window.location.href =
          "/login?next=" + encodeURIComponent(window.location.pathname);
      }, 1200);
    }
    return res;
  };

  // ---- Icon rendering ----
  // A Homepage icon string resolves to one of two things: a plain URL (dashboard
  // icons, selfh.st, uploads, arbitrary links) or an Iconify prefix + name.
  // URLs render as <img>. Iconify icons are fetched in batches through this
  // app's disk-cached proxy and injected as inline <svg> — pointing <img src>
  // straight at api.iconify.design meant one request per icon, and a single
  // picker search fired enough of them to trip Cloudflare's rate limit for the
  // whole source IP (error 1015), after which every preview fell back to "?".
  // Inline SVG also makes colour a pure CSS concern: the bodies paint with
  // currentColor, so recolouring costs no network at all.
  const ICONIFY = "https://api.iconify.design";
  const DASH = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
  const SELFHST = "https://cdn.jsdelivr.net/gh/selfhst/icons";

  // Homepage supports a trailing `-#hexcolor` on mdi/si/sh icons.
  const COLOR_PREFIXES = ["mdi", "si", "sh"];
  const FA_SETS = {
    fab: "fa6-brands", far: "fa6-regular", fal: "fa6-regular",
    fas: "fa6-solid", fad: "fa6-solid", fa: "fa6-solid",
  };

  function splitColorSuffix(name) {
    const m = name.match(/^(.*)-#([0-9a-fA-F]{3,8})$/);
    if (m) return { base: m[1], color: "#" + m[2] };
    return { base: name, color: null };
  }

  // Split an icon string into { prefix, base, color } where applicable.
  function parseIcon(icon) {
    icon = String(icon || "").trim();
    for (const p of COLOR_PREFIXES) {
      const m = icon.match(new RegExp(`^${p}-(.+)$`, "i"));
      if (m) {
        const { base, color } = splitColorSuffix(m[1]);
        return { prefix: p, base, color };
      }
    }
    return null;
  }

  // Unified color model for the editor. Two recolorable schemes:
  //   - "suffix":  mdi-/si-/sh- icons carry color as a trailing -#hex
  //   - "iconify": Iconify SVG URLs carry color as a ?color= query param
  // Returns { supported, scheme, base, prefix?, color } (color is #rrggbb or null).
  function iconColorInfo(icon) {
    icon = String(icon || "").trim();
    if (!icon) return { supported: false };

    const u = icon.match(/^(https?:\/\/api\.iconify\.design\/[^?#]+\.svg)(\?[^#]*)?$/i);
    if (u) {
      let color = null;
      if (u[2]) {
        const m = u[2].match(/[?&]color=([^&]+)/i);
        if (m) {
          try { color = decodeURIComponent(m[1]); } catch (e) { color = m[1]; }
          if (color && color[0] !== "#") color = "#" + color.replace(/^#?/, "");
        }
      }
      return { supported: true, scheme: "iconify", base: u[1], color };
    }

    const p = parseIcon(icon);
    if (p) return { supported: true, scheme: "suffix", prefix: p.prefix, base: p.base, color: p.color };

    return { supported: false };
  }

  // Build an icon value with (or without) an overriding color, per its scheme.
  function applyColorToIcon(info, hex) {
    if (info.scheme === "iconify") {
      return hex ? `${info.base}?color=${encodeURIComponent(hex)}` : info.base;
    }
    // suffix scheme (mdi/si/sh)
    return hex ? `${info.prefix}-${info.base}-${hex}` : `${info.prefix}-${info.base}`;
  }

  // Icon string -> { kind: "url", url } | { kind: "iconify", prefix, name, color }
  function resolveIcon(icon) {
    icon = String(icon || "").trim();
    if (!icon) return null;

    // An Iconify SVG URL (what the SVG tab stores) is rendered inline like any
    // other Iconify icon rather than fetched one-off.
    let m = icon.match(
      /^https?:\/\/api\.iconify\.design\/([a-z0-9-]+)\/([a-z0-9._-]+)\.svg(?:\?([^#]*))?$/i
    );
    if (m) {
      let color = null;
      if (m[3]) {
        const c = m[3].match(/(?:^|&)color=([^&]+)/i);
        if (c) {
          try { color = decodeURIComponent(c[1]); } catch (e) { color = c[1]; }
          if (color && color[0] !== "#") color = "#" + color.replace(/^#?/, "");
        }
      }
      return { kind: "iconify", prefix: m[1].toLowerCase(), name: m[2].toLowerCase(), color };
    }

    if (/^https?:\/\//i.test(icon)) return { kind: "url", url: icon };
    // Root-relative (e.g. /icons/foo.png) — Homepage serves these, and so does
    // this app at the same path, so previews resolve against our own origin.
    if (icon.startsWith("/")) return { kind: "url", url: icon };

    // Dashboard icons: name.svg / name.png / name.webp (jsDelivr, never throttled)
    m = icon.match(/^(.+)\.(svg|png|webp)$/i);
    if (m) return { kind: "url", url: `${DASH}/${m[2].toLowerCase()}/${icon}` };

    // Material Design Icons: mdi-name or mdi-name-#hexcolor
    m = icon.match(/^mdi-(.+)$/i);
    if (m) {
      const { base, color } = splitColorSuffix(m[1]);
      return { kind: "iconify", prefix: "mdi", name: base.toLowerCase(), color };
    }

    // Simple Icons: si-name or si-name-#hexcolor
    m = icon.match(/^si-(.+)$/i);
    if (m) {
      const { base, color } = splitColorSuffix(m[1]);
      return { kind: "iconify", prefix: "simple-icons", name: base.toLowerCase(), color };
    }

    // Selfh.st icons have no Iconify prefix, so they stay on jsDelivr. Homepage
    // honours a color suffix here; the preview can't, as with the old build.
    m = icon.match(/^sh-(.+)$/i);
    if (m) {
      const { base } = splitColorSuffix(m[1]);
      return { kind: "url", url: `${SELFHST}/svg/${base.replace(/\.(svg|png)$/i, "")}.svg` };
    }

    // Font Awesome: fas- far- fab- fal- fad- fa-
    m = icon.match(/^(fas|far|fab|fal|fad|fa)-(.+)$/i);
    if (m) {
      return { kind: "iconify", prefix: FA_SETS[m[1].toLowerCase()], name: m[2].toLowerCase(), color: null };
    }

    // prefix:name (raw iconify)
    m = icon.match(/^([a-z0-9-]+):([a-z0-9._-]+)$/i);
    if (m) return { kind: "iconify", prefix: m[1].toLowerCase(), name: m[2].toLowerCase(), color: null };

    return null;
  }

  // ---- Batched Iconify loader ----
  // Every request made in the same tick is coalesced into one call to our proxy,
  // which answers from disk when it can. Results are memoized for the session.
  const iconMemo = new Map(); // "prefix:name" -> entry | null (known missing)
  let iconQueue = new Map();  // "prefix:name" -> [resolve, …]
  let iconFlushTimer = null;

  function loadIconifyIcon(prefix, name) {
    const key = `${prefix}:${name}`;
    if (iconMemo.has(key)) return Promise.resolve(iconMemo.get(key));
    return new Promise((resolve) => {
      const waiting = iconQueue.get(key);
      if (waiting) { waiting.push(resolve); return; }
      iconQueue.set(key, [resolve]);
      if (!iconFlushTimer) iconFlushTimer = setTimeout(flushIconQueue, 24);
    });
  }

  async function flushIconQueue() {
    iconFlushTimer = null;
    const queue = iconQueue;
    iconQueue = new Map();
    const keys = Array.from(queue.keys());

    // Chunks go out together: a 120-result search is two requests, not two
    // round-trips one after the other.
    const chunks = [];
    for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));

    await Promise.all(chunks.map(async (chunk) => {
      let icons = {};
      let settled = false;
      let limited = false;
      try {
        const res = await fetch(
          "/api/iconify/icons?icons=" + encodeURIComponent(chunk.join(","))
        );
        const data = await res.json();
        if (res.ok) {
          icons = data.icons || {};
          limited = !!data.rateLimited;
          settled = true;
        }
      } catch (e) {
        // Leave settled false so a transient failure isn't cached as a miss.
      }
      if (limited) iconRateNotice();
      chunk.forEach((key) => {
        const entry = icons[key] || null;
        if (entry) iconMemo.set(key, entry);
        else if (settled && !limited) iconMemo.set(key, null);
        (queue.get(key) || []).forEach((fn) => fn(entry));
      });
    }));
  }

  let rateNoticeAt = 0;
  function iconRateNotice() {
    // One nudge a minute at most — a rate-limited batch can report this 100 times.
    if (Date.now() - rateNoticeAt < 60000) return;
    rateNoticeAt = Date.now();
    toast("Iconify is rate limiting this host — cached icons still work.", "err");
  }

  function svgMarkup(entry) {
    const w = entry.width || 24;
    const h = entry.height || 24;
    const l = entry.left || 0;
    const t = entry.top || 0;
    let body = entry.body || "";
    const tf = [];
    // Aliases can rotate or flip their parent. Rotation pivots on the box centre,
    // which is exact for the square icons Iconify almost always ships.
    if (entry.rotate) tf.push(`rotate(${(entry.rotate % 4) * 90} ${l + w / 2} ${t + h / 2})`);
    if (entry.hFlip) tf.push(`translate(${l * 2 + w} 0) scale(-1 1)`);
    if (entry.vFlip) tf.push(`translate(0 ${t * 2 + h}) scale(1 -1)`);
    if (tf.length) body = `<g transform="${tf.join(" ")}">${body}</g>`;
    const odd = entry.rotate % 2 === 1;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${l} ${t} ${odd ? h : w} ${odd ? w : h}"` +
      ` aria-hidden="true" focusable="false">${body}</svg>`
    );
  }

  // Paint `icon` into the slot that owns `imgEl`, with `fallbackEl` as the "?"
  // placeholder. Resolves true once something was actually drawn.
  let renderSeq = 0;
  function renderIcon(imgEl, fallbackEl, icon) {
    if (!imgEl) return Promise.resolve(false);
    const slot = imgEl.parentNode;
    const seq = String(++renderSeq);
    imgEl.dataset.seq = seq;
    const current = () => imgEl.dataset.seq === seq;

    const dropSvg = () => {
      const old = slot && slot.querySelector(":scope > svg");
      if (old) old.remove();
    };
    const showFallback = () => {
      dropSvg();
      imgEl.removeAttribute("src");
      imgEl.style.display = "none";
      if (fallbackEl) fallbackEl.style.display = "";
    };

    const src = resolveIcon(icon);
    if (!src) { showFallback(); return Promise.resolve(false); }

    if (src.kind === "url") {
      dropSvg();
      imgEl.style.display = "";
      if (fallbackEl) fallbackEl.style.display = "none";
      return new Promise((resolve) => {
        imgEl.onload = () => resolve(current());
        imgEl.onerror = () => { if (current()) showFallback(); resolve(false); };
        imgEl.src = src.url;
      });
    }

    // Iconify: hide the <img> but leave any existing paint in place until the
    // batch resolves, so re-rendering doesn't flash "?" on every keystroke.
    imgEl.removeAttribute("src");
    imgEl.style.display = "none";
    return loadIconifyIcon(src.prefix, src.name).then((entry) => {
      if (!current()) return false;
      if (!entry) { showFallback(); return false; }
      const holder = document.createElement("span");
      holder.innerHTML = svgMarkup(entry);
      const svg = holder.firstElementChild;
      if (!svg) { showFallback(); return false; }
      dropSvg();
      if (src.color) svg.style.color = src.color;
      if (fallbackEl) fallbackEl.style.display = "none";
      slot.insertBefore(svg, imgEl.nextSibling);
      return true;
    });
  }

  // ---- Load / build state ----
  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      if (!res.ok) {
        // Nothing at the configured path: open the connection dialog rather
        // than leaving an empty canvas behind an error toast.
        if (data.missing_file) {
          toast(data.error, "err");
          showConnection();
          return;
        }
        throw new Error(data.error || "Failed to load");
      }
      buildState(data);
      render();
      setDirty(false);
      toast("Loaded services.yaml", "ok");
    } catch (e) {
      toast("Load error: " + e.message, "err");
    }
  }

  function buildState(data) {
    groupById.clear();
    serviceById.clear();
    state = { groups: [] };
    (data.groups || []).forEach((g) => {
      const gid = uid("g");
      const group = {
        id: gid,
        name: g.name || "",
        type: g.type || "services",
        services: [],
        raw: g.raw,
      };
      (g.services || []).forEach((s) => {
        const sid = uid("s");
        const svc = { id: sid, name: s.name || "", config: s.config || {} };
        serviceById.set(sid, svc);
        group.services.push(svc);
      });
      groupById.set(gid, group);
      state.groups.push(group);
    });
  }

  function exportPayload() {
    return {
      groups: state.groups.map((g) => {
        if (g.type === "raw") return { name: g.name, type: "raw", raw: g.raw };
        return {
          name: g.name,
          type: "services",
          services: g.services.map((s) => ({ name: s.name, config: s.config || {} })),
        };
      }),
    };
  }

  // ---- Render ----
  const groupTpl = $("#groupTpl");
  const serviceTpl = $("#serviceTpl");
  let groupsSortable = null;
  const listSortables = [];

  function render() {
    const container = $("#groups");
    container.innerHTML = "";
    listSortables.length = 0;

    state.groups.forEach((g) => container.appendChild(renderGroup(g)));

    $("#emptyState").classList.toggle("hidden", state.groups.length > 0);

    initGroupSortable();
    renderNav();
    updateTotals();
  }

  function renderGroup(g) {
    const node = groupTpl.content.firstElementChild.cloneNode(true);
    node.dataset.gid = g.id;
    const nameInput = $(".group-name", node);
    nameInput.value = g.name;
    nameInput.addEventListener("input", () => {
      g.name = nameInput.value;
      setDirty(true);
      updateNavName(g);
    });

    if (g.type === "raw") {
      $(".add-service", node).style.display = "none";
      const list = $(".service-list", node);
      const note = document.createElement("div");
      note.className = "hint";
      note.style.padding = "8px";
      note.textContent = "Group-level settings (edit via Preview / raw YAML).";
      list.appendChild(note);
    } else {
      const list = $(".service-list", node);
      g.services.forEach((s) => list.appendChild(renderService(s)));
      updateCount(node, g);

      $(".add-service", node).addEventListener("click", () => addService(g));
      $(".sort-group", node).addEventListener("click", () => sortGroup(g));
      initListSortable(list);
    }

    $(".del-group", node).addEventListener("click", () => deleteGroup(g));
    return node;
  }

  function renderService(s) {
    const node = serviceTpl.content.firstElementChild.cloneNode(true);
    node.dataset.sid = s.id;
    refreshServiceCard(node, s);
    $(".edit-svc", node).addEventListener("click", () => openEditor(s));
    $(".del-svc", node).addEventListener("click", () => deleteService(s));
    node.addEventListener("dblclick", (e) => {
      if (e.target.closest(".icon-btn") || e.target.closest(".drag-handle")) return;
      openEditor(s);
    });
    return node;
  }

  function refreshServiceCard(node, s) {
    $(".svc-name", node).textContent = s.name || "(unnamed)";
    const cfg = s.config || {};
    const sub = cfg.href || cfg.description || cfg.ping || "";
    $(".svc-sub", node).textContent = sub;
    $(".svc-sub", node).title = sub;
    renderIcon($(".svc-icon img", node), $(".svc-icon .icon-fallback", node), cfg.icon);
  }

  function cardEl(s) {
    return $(`.service-card[data-sid="${s.id}"]`);
  }
  function groupEl(g) {
    return $(`.group[data-gid="${g.id}"]`);
  }

  function updateCount(groupNode, g) {
    $(".count-pill", groupNode).textContent =
      g.services.length + (g.services.length === 1 ? " item" : " items");
  }

  // ---- Sidebar nav ----
  function renderNav() {
    const nav = $("#sectionNav");
    nav.innerHTML = "";
    state.groups.forEach((g) => {
      const li = document.createElement("li");
      li.dataset.gid = g.id;
      li.innerHTML = `<span class="nav-handle drag-handle">⠿</span>
        <span class="nav-name"></span>
        <span class="nav-count"></span>`;
      $(".nav-name", li).textContent = g.name || "(unnamed)";
      $(".nav-count", li).textContent = g.type === "raw" ? "⚙" : g.services.length;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".nav-handle")) return;
        const el = groupEl(g);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      nav.appendChild(li);
    });
    initNavSortable();
  }

  function updateNavName(g) {
    const li = $(`#sectionNav li[data-gid="${g.id}"]`);
    if (li) $(".nav-name", li).textContent = g.name || "(unnamed)";
  }

  function updateTotals() {
    const groups = state.groups.length;
    const svcs = state.groups.reduce((n, g) => n + (g.services ? g.services.length : 0), 0);
    $("#statTotals").textContent = `${groups} sections · ${svcs} services`;
  }

  function refreshNavCounts() {
    state.groups.forEach((g) => {
      const li = $(`#sectionNav li[data-gid="${g.id}"]`);
      if (li && g.type !== "raw") $(".nav-count", li).textContent = g.services.length;
      const gel = groupEl(g);
      if (gel && g.type !== "raw") updateCount(gel, g);
    });
    updateTotals();
  }

  // ---- Drag & drop ----
  function initGroupSortable() {
    if (groupsSortable) groupsSortable.destroy();
    groupsSortable = Sortable.create($("#groups"), {
      handle: ".group-drag",
      animation: 150,
      ghostClass: "drag-ghost",
      draggable: ".group",
      onEnd: () => { syncOrderFromDom(); renderNav(); setDirty(true); },
    });
  }

  function initNavSortable() {
    Sortable.create($("#sectionNav"), {
      handle: ".nav-handle",
      animation: 150,
      onEnd: () => {
        // Reorder state.groups to match nav, then re-render canvas to match.
        const order = $$("#sectionNav li").map((li) => li.dataset.gid);
        state.groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        render();
        setDirty(true);
      },
    });
  }

  function initListSortable(list) {
    const s = Sortable.create(list, {
      group: "services",
      handle: ".drag-handle",
      animation: 150,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      draggable: ".service-card",
      onAdd: (evt) => {
        if (evt.item.classList && evt.item.classList.contains("palette-block")) {
          // Dropped a palette "Service" block -> create a new service here.
          const gid = evt.to.closest(".group").dataset.gid;
          const g = groupById.get(gid);
          evt.item.remove();
          const svc = { id: uid("s"), name: "New service", config: {} };
          serviceById.set(svc.id, svc);
          syncOrderFromDom();
          g.services.splice(evt.newIndex, 0, svc);
          render();
          setDirty(true);
          openEditor(svc, true);
        } else {
          syncOrderFromDom();
          refreshNavCounts();
          setDirty(true);
        }
      },
      onUpdate: () => { syncOrderFromDom(); setDirty(true); },
      onRemove: () => { /* handled by onAdd's syncOrderFromDom on the target */ },
    });
    listSortables.push(s);
  }

  // Rebuild group/service ordering from the current DOM (handles cross-group moves).
  function syncOrderFromDom() {
    const newGroups = [];
    $$("#groups .group").forEach((gEl) => {
      const g = groupById.get(gEl.dataset.gid);
      if (!g) return;
      if (g.type === "services") {
        const svcs = [];
        $$(".service-card", gEl).forEach((sEl) => {
          const s = serviceById.get(sEl.dataset.sid);
          if (s) svcs.push(s);
        });
        g.services = svcs;
      }
      newGroups.push(g);
    });
    state.groups = newGroups;
    refreshNavCounts();
  }

  // ---- Mutations ----
  function addGroup() {
    const g = { id: uid("g"), name: "New Section", type: "services", services: [] };
    groupById.set(g.id, g);
    state.groups.push(g);
    render();
    setDirty(true);
    const el = groupEl(g);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const input = $(".group-name", el);
      input.focus();
      input.select();
    }
  }

  function deleteGroup(g) {
    if (g.services && g.services.length) {
      if (!confirm(`Delete section "${g.name}" and its ${g.services.length} service(s)?`)) return;
    }
    state.groups = state.groups.filter((x) => x !== g);
    groupById.delete(g.id);
    (g.services || []).forEach((s) => serviceById.delete(s.id));
    render();
    setDirty(true);
  }

  function sortGroup(g) {
    if (g.type === "raw" || !g.services.length) return;
    const dir = g._sortDir === "asc" ? -1 : 1;
    g._sortDir = dir === 1 ? "asc" : "desc";
    g.services.sort(
      (a, b) =>
        dir *
        (a.name || "").localeCompare(b.name || "", undefined, {
          sensitivity: "base",
          numeric: true,
        })
    );
    // Re-render just this group's list to reflect the new order.
    const gel = groupEl(g);
    if (gel) {
      const list = $(".service-list", gel);
      list.innerHTML = "";
      g.services.forEach((s) => list.appendChild(renderService(s)));
      initListSortable(list);
    }
    setDirty(true);
    toast(`Sorted "${g.name}" ${dir === 1 ? "A→Z" : "Z→A"}`, "info");
  }

  function addService(g) {
    const svc = { id: uid("s"), name: "New service", config: {} };
    serviceById.set(svc.id, svc);
    g.services.push(svc);
    const gel = groupEl(g);
    if (gel) {
      $(".service-list", gel).appendChild(renderService(svc));
      updateCount(gel, g);
    }
    refreshNavCounts();
    setDirty(true);
    openEditor(svc, true);
  }

  function deleteService(s) {
    const g = state.groups.find((x) => x.services && x.services.includes(s));
    if (!g) return;
    g.services = g.services.filter((x) => x !== s);
    serviceById.delete(s.id);
    const el = cardEl(s);
    if (el) el.remove();
    refreshNavCounts();
    setDirty(true);
  }

  // ---- Editor drawer ----
  function openEditor(s, isNew = false) {
    const g = state.groups.find((x) => x.services && x.services.includes(s));
    editing = { group: g, service: s, isNew };
    $("#editorTitle").textContent = isNew ? "New service" : "Edit service";
    $("#f_name").value = s.name || "";
    const cfg = s.config || {};
    COMMON.forEach((k) => { $("#f_" + k).value = cfg[k] != null ? cfg[k] : ""; });

    // Advanced = everything not in COMMON.
    const extra = {};
    Object.keys(cfg).forEach((k) => { if (!COMMON.includes(k)) extra[k] = cfg[k]; });
    $("#f_advanced").value = Object.keys(extra).length
      ? jsyaml.dump(extra, { lineWidth: -1 })
      : "";
    $("#advError").textContent = "";
    $("details.advanced").open = Object.keys(extra).length > 0;

    updateEditorIconPreview();
    $("#editorOverlay").classList.remove("hidden");
    setTimeout(() => $("#f_name").focus(), 30);
  }

  function closeEditor() {
    $("#editorOverlay").classList.add("hidden");
    editing = null;
  }

  function applyEditor() {
    if (!editing) return;
    const s = editing.service;
    let extra = {};
    const advText = $("#f_advanced").value.trim();
    if (advText) {
      try {
        const parsed = jsyaml.load(advText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          extra = parsed;
        } else {
          $("#advError").textContent = "Advanced fields must be a YAML mapping (key: value).";
          return;
        }
      } catch (e) {
        $("#advError").textContent = "YAML error: " + e.message;
        return;
      }
    }

    const cfg = {};
    COMMON.forEach((k) => {
      const v = $("#f_" + k).value;
      if (v !== "" && v != null) cfg[k] = v;
    });
    Object.keys(extra).forEach((k) => { if (!(k in cfg)) cfg[k] = extra[k]; });

    s.name = $("#f_name").value.trim() || "Unnamed";
    s.config = cfg;

    const el = cardEl(s);
    if (el) refreshServiceCard(el, s);
    setDirty(true);
    closeEditor();
  }

  function deleteFromEditor() {
    if (!editing) return;
    const s = editing.service;
    closeEditor();
    deleteService(s);
  }

  function updateEditorIconPreview() {
    renderIcon($("#iconPreview"), $("#iconPreviewFallback"), $("#f_icon").value);
    refreshIconColorUI();
  }

  function toHex6(c) {
    if (!c) return "#3b82f6";
    let h = c.replace("#", "");
    if (h.length === 3) h = h.split("").map((x) => x + x).join("");
    else if (h.length === 4) h = h.slice(0, 3).split("").map((x) => x + x).join("");
    else if (h.length === 8) h = h.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "#3b82f6";
    return "#" + h.toLowerCase();
  }

  // Sync the editor's color control to the current icon value.
  function refreshIconColorUI() {
    const icon = $("#f_icon").value.trim();
    const field = $("#iconColorField");
    const chk = $("#f_icon_usecolor");
    const colorInput = $("#f_icon_color");
    const valEl = $("#iconColorVal");
    const hintEl = $("#iconColorHint");
    const info = iconColorInfo(icon);

    field.classList.toggle("unsupported", !info.supported);
    if (!info.supported) {
      chk.checked = false;
      chk.disabled = true;
      colorInput.disabled = true;
      valEl.textContent = "";
      hintEl.textContent = icon
        ? "This icon type uses a fixed color."
        : "Color works with mdi-, si-, sh- and SVG (Iconify) icons.";
      return;
    }

    hintEl.textContent =
      info.scheme === "iconify" ? "Overrides this SVG icon's color." : "";
    chk.disabled = false;
    const hasColor = !!info.color;
    chk.checked = hasColor;
    colorInput.disabled = !hasColor;
    if (hasColor) {
      colorInput.value = toHex6(info.color);
      valEl.textContent = info.color;
    } else {
      valEl.textContent = "";
    }
  }

  // Apply the color control back onto the icon value.
  function applyIconColorFromUI() {
    const info = iconColorInfo($("#f_icon").value.trim());
    if (!info.supported) return;
    const chk = $("#f_icon_usecolor");
    const colorInput = $("#f_icon_color");
    colorInput.disabled = !chk.checked;
    const hex = chk.checked ? colorInput.value.toLowerCase() : null;
    $("#f_icon").value = applyColorToIcon(info, hex);
    updateEditorIconPreview();
  }

  // ---- Icon chooser ----
  // `browse` sources list something before anything is typed; the rest wait
  // for a query. `recolor` sources are single-color glyphs the color control
  // can tint; `fixed` says why the others can't be.
  const ICON_SOURCES = {
    all: {
      name: "all sources", placeholder: "Search every source…", recolor: true, link: true,
      idleTitle: "Search every source at once",
      idleText: "Dashboard Icons, Material, Font Awesome, Simple Icons and over 200,000 SVGs from Iconify.",
    },
    dashboard: {
      name: "Dashboard Icons", placeholder: "Filter Dashboard Icons…", browse: true,
      fixed: "Dashboard Icons keep their own colors.",
    },
    mdi: {
      name: "Material", placeholder: "Search Material Design Icons…", recolor: true,
      idleTitle: "Search Material Design Icons",
      idleText: "Over 7,000 single-color glyphs that Homepage can recolor.",
    },
    fa: {
      name: "Font Awesome", placeholder: "Search Font Awesome…",
      fixed: "Font Awesome icons keep their own color.",
      idleTitle: "Search Font Awesome",
      idleText: "The free solid, regular and brand sets.",
    },
    svg: {
      name: "Any SVG", placeholder: "Search any SVG icon…", recolor: true, link: true,
      idleTitle: "Search over 200,000 SVG icons",
      idleText: "Every Iconify icon set. The icon is stored as a direct URL.",
    },
    uploads: {
      name: "your uploads", placeholder: "Filter your uploads…", browse: true,
      fixed: "Uploads keep their own colors.",
    },
  };
  const ICON_SUGGESTIONS = ["server", "router", "camera", "media", "database", "cloud"];

  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  let activeIconSrc = ICON_SOURCES[stored("hg-icon-src")] ? stored("hg-icon-src") : "all";
  let dashboardList = null;
  let pickColor = "#3b82f6";
  // Color is opt-in: leave it off so picks carry no color suffix and Homepage
  // renders its default gradient. Only set when the user ticks "Recolor results".
  let pickUseColor = false;
  let searchSeq = 0;
  let searchTimer = null;

  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  function openIconPicker() {
    $("#iconOverlay").classList.remove("hidden");
    setIconSrc(activeIconSrc);
    loadUploads().catch(() => { /* the count just stays hidden */ });
    setTimeout(() => {
      const input = $("#iconSearch");
      input.focus();
      input.select();
    }, 30);
  }
  function closeIconPicker() {
    clearTimeout(searchTimer);
    searchSeq++; // a search still in flight has nowhere to land
    $("#iconOverlay").classList.add("hidden");
  }

  function setIconSrc(src) {
    activeIconSrc = src;
    store("hg-icon-src", src);
    const meta = ICON_SOURCES[src];
    $$("#iconSources .src").forEach((b) => {
      const on = b.dataset.src === src;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    $("#iconSearch").placeholder = meta.placeholder;
    $("#uploadControls").classList.toggle("hidden", src !== "uploads");
    $("#freesvgLink").classList.toggle("hidden", !meta.link);
    $("#recolorBox").classList.toggle("is-off", !meta.recolor);
    $("#pickColorOn").disabled = !meta.recolor;
    // Shown unticked where it can't apply; the choice comes back with the source.
    $("#pickColorOn").checked = meta.recolor && pickUseColor;
    $("#pickColor").disabled = !meta.recolor || !pickUseColor;
    $("#recolorNote").textContent = meta.recolor
      ? (src === "all" ? "Applies to Material, Simple Icons and SVG results." : "")
      : meta.fixed;
    const results = $("#iconResults");
    results.classList.toggle("show-badges", src === "all");
    // Another source's icons dimmed under a spinner would read as this
    // source's results, so start from placeholders instead.
    results.replaceChildren();
    runIconSearch();
  }

  function willFetch(q) {
    return !!q || !!ICON_SOURCES[activeIconSrc].browse;
  }

  // The spinner shows on the keystroke, not when the debounce fires, so the
  // chooser never looks like it ignored what was typed.
  function scheduleIconSearch(delay = 220) {
    clearTimeout(searchTimer);
    if (willFetch($("#iconSearch").value.trim())) setIconBusy(true);
    searchTimer = setTimeout(runIconSearch, delay);
  }

  function setIconBusy(on) {
    $(".icon-search").classList.toggle("is-busy", on);
    const results = $("#iconResults");
    results.classList.toggle("is-busy", on);
    if (!on) return;
    setIconStatus("Searching…");
    $("#iconEmpty").classList.add("hidden");
    // Results on screen dim while the next ones load; an empty grid holds
    // its shape with placeholder tiles.
    if (!results.querySelector(".icon-cell")) results.replaceChildren(skeletonCells(24));
  }

  function skeletonCells(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const c = document.createElement("div");
      c.className = "icon-cell is-skel";
      c.setAttribute("aria-hidden", "true");
      c.innerHTML = '<span class="cell-art"></span><span class="cell-label"></span>';
      frag.appendChild(c);
    }
    return frag;
  }

  function setIconStatus(text) {
    $("#iconStatus").textContent = text;
  }

  async function runIconSearch() {
    clearTimeout(searchTimer);
    const q = $("#iconSearch").value.trim();
    const src = activeIconSrc;
    const seq = ++searchSeq;
    if (!willFetch(q)) {
      setIconBusy(false);
      setIconStatus("");
      const meta = ICON_SOURCES[src];
      showIconEmpty(meta.idleTitle, meta.idleText,
        ICON_SUGGESTIONS.map((s) => [s, () => searchIconsFor(s)]), true);
      return;
    }
    setIconBusy(true);
    let items;
    try {
      items = await fetchIconItems(src, q);
    } catch (e) {
      if (seq !== searchSeq) return;
      setIconBusy(false);
      setIconStatus("");
      showIconEmpty("The search didn't finish",
        e.rateLimited
          ? `${e.message} Wait a minute, then try again. Icons already seen still work.`
          : `${e.message} Check this host's internet connection, then try again.`,
        [["Try again", runIconSearch]]);
      return;
    }
    if (seq !== searchSeq) return;
    setIconBusy(false);
    fillIconResults(src, q, items, seq);
  }

  function searchIconsFor(q) {
    const input = $("#iconSearch");
    input.value = q;
    input.focus();
    runIconSearch();
  }

  // Every source comes back as the same shape: the value Homepage stores, a
  // label, the badge for "All sources", and the Iconify id of anything the
  // color control can retint in place.
  async function fetchIconItems(src, q) {
    const ql = q.toLowerCase();
    const dashItem = (n) => ({ value: n, label: n.replace(/\.svg$/, ""), badge: "DASH" });
    const fromIconify = (full, map = "hp") => {
      const [prefix, name] = full.split(":");
      const m = iconifyToHomepage(prefix, name);
      return {
        value: map === "url" ? iconifyUrl(prefix, name) : m.value,
        label: map === "url" ? full : prefix.startsWith("fa6-") ? m.value : name,
        badge: map === "url" ? "SVG" : m.badge,
        prefix, name, map,
      };
    };

    if (src === "uploads") {
      const icons = await loadUploads();
      return icons
        .filter((it) => !q || it.name.toLowerCase().includes(ql))
        .map((it) => ({ value: it.ref, label: it.name, upload: it.name }));
    }
    if (src === "dashboard") {
      await ensureDashboardList();
      return dashboardList.filter((n) => !q || n.toLowerCase().includes(ql)).slice(0, 200).map(dashItem);
    }
    if (src === "all") {
      const [, icons] = await Promise.all([ensureDashboardList(), iconifySearch(q, { limit: 120 })]);
      const dash = dashboardList.filter((n) => n.toLowerCase().includes(ql)).slice(0, 24);
      return dash.map(dashItem).concat(icons.map((full) => fromIconify(full)));
    }
    if (src === "mdi") {
      return (await iconifySearch(q, { prefix: "mdi", limit: 120 })).map((full) => fromIconify(full));
    }
    if (src === "fa") {
      const sets = await Promise.all(
        ["fa6-solid", "fa6-regular", "fa6-brands"].map((p) => iconifySearch(q, { prefix: p, limit: 48 }))
      );
      return sets.flat().map((full) => fromIconify(full));
    }
    return (await iconifySearch(q, { limit: 120 })).map((full) => fromIconify(full, "url"));
  }

  function fillIconResults(src, q, items, seq) {
    if (!items.length) { showNoIcons(src, q); return; }
    $("#iconEmpty").classList.add("hidden");
    const results = $("#iconResults");
    const current = $("#f_icon").value.trim();
    let shown = items.length;
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => {
      frag.appendChild(iconCell(it, i, current, () => {
        // A result that won't render is noise: it was dropped, so keep the
        // count honest.
        if (seq !== searchSeq) return;
        shown--;
        if (shown) setIconStatus(iconSummary(src, q, shown));
        else showNoIcons(src, q);
      }));
    });
    results.replaceChildren(frag);
    results.scrollTop = 0;
    setIconStatus(iconSummary(src, q, shown));
  }

  function iconSummary(src, q, n) {
    if (src === "all") return `${plural(n, "result")} across all sources`;
    if (src === "uploads") return `${plural(n, "upload")}. Restart Homepage after uploading so it serves new files.`;
    if (src === "dashboard" && !q) {
      return `Showing ${n.toLocaleString()} of ${dashboardList.length.toLocaleString()}. Type to filter.`;
    }
    if (src === "svg") return `${plural(n, "icon")}, stored as a direct URL`;
    return `${plural(n, "icon")} in ${ICON_SOURCES[src].name}`;
  }

  function showNoIcons(src, q) {
    setIconStatus("");
    if (src === "uploads" && !q) {
      showIconEmpty("No uploads yet",
        "Drop PNG or SVG files here, or upload them. Restart Homepage afterwards so it serves them.",
        [["⤓ Upload PNG or SVG", () => $("#iconUpload").click()]]);
    } else if (src === "all") {
      showIconEmpty(`Nothing matches “${q}”`, "Try a shorter or more general word.");
    } else {
      showIconEmpty(`Nothing matches “${q}” in ${ICON_SOURCES[src].name}`,
        "Another source may have it.",
        [["Search all sources", () => setIconSrc("all")]]);
    }
  }

  // actions: [[label, onClick], …], shown as buttons or, for suggestions, chips.
  function showIconEmpty(title, text, actions = [], chips = false) {
    $("#iconResults").replaceChildren();
    $("#iconEmptyTitle").textContent = title;
    $("#iconEmptyText").textContent = text;
    const box = $("#iconEmptyActions");
    box.replaceChildren();
    if (chips && actions.length) {
      const lead = document.createElement("span");
      lead.className = "chip-lead";
      lead.textContent = "Try";
      box.appendChild(lead);
    }
    actions.forEach(([label, fn]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = chips ? "chip" : "btn ghost sm";
      b.textContent = label;
      b.addEventListener("click", fn);
      box.appendChild(b);
    });
    $("#iconEmpty").classList.remove("hidden");
  }

  // The cell previews the value it would store, so what you see is what the
  // editor gets, color included.
  function iconCell(it, i, current, onDrop) {
    const cell = document.createElement("div");
    cell.className = "icon-cell";
    cell.tabIndex = 0;
    cell.setAttribute("role", "button");
    cell.dataset.value = it.value;
    cell.title = it.value;
    cell.style.setProperty("--i", Math.min(i, 40));
    if (it.prefix) {
      cell.dataset.prefix = it.prefix;
      cell.dataset.name = it.name;
      cell.dataset.map = it.map;
    }
    markCurrent(cell, current);
    if (it.badge) {
      const b = document.createElement("span");
      b.className = "cell-badge b-" + it.badge.toLowerCase();
      b.textContent = it.badge;
      cell.appendChild(b);
    }
    if (it.upload) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "cell-del";
      del.textContent = "✕";
      del.title = "Delete this upload";
      del.dataset.name = it.upload;
      cell.appendChild(del);
    }
    const art = document.createElement("span");
    art.className = "cell-art is-loading";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = it.label;
    const fb = document.createElement("span");
    fb.className = "icon-fallback";
    fb.textContent = "?";
    art.append(img, fb);
    const lab = document.createElement("span");
    lab.className = "cell-label";
    lab.textContent = it.label;
    cell.append(art, lab);
    renderIcon(img, fb, it.value).then((ok) => {
      art.classList.remove("is-loading");
      // An upload that won't draw stays, with its "?", so it can be deleted.
      if (!ok && !it.upload) { cell.remove(); onDrop(); }
    });
    return cell;
  }

  function markCurrent(cell, current) {
    const on = !!current && cell.dataset.value === current;
    cell.classList.toggle("is-current", on);
    if (on) cell.setAttribute("aria-current", "true");
    else cell.removeAttribute("aria-current");
  }

  // Recoloring rewrites each cell's value and tints its inline SVG: the
  // glyphs are already on screen, so there is nothing to fetch again.
  function recolorIconCells() {
    const current = $("#f_icon").value.trim();
    $$("#iconResults .icon-cell[data-prefix]").forEach((cell) => {
      const { prefix, name, map } = cell.dataset;
      const value = map === "url" ? iconifyUrl(prefix, name) : iconifyToHomepage(prefix, name).value;
      cell.dataset.value = value;
      cell.title = value;
      const svg = $(".cell-art svg", cell);
      if (svg) svg.style.color = (resolveIcon(value) || {}).color || "";
      markCurrent(cell, current);
    });
  }

  function moveIconFocus(from, key) {
    const cells = $$("#iconResults .icon-cell:not(.is-skel)");
    const i = cells.indexOf(from);
    const cols = Math.max(1, cells.filter((c) => c.offsetTop === cells[0].offsetTop).length);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[key];
    const j = i + step;
    if (j < 0) { $("#iconSearch").focus(); return; }
    const next = cells[Math.min(j, cells.length - 1)];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  }

  async function loadUploads() {
    const res = await fetch("/api/icons");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not list your uploads.");
    const icons = data.icons || [];
    const count = $("#uploadsCount");
    count.textContent = icons.length;
    count.classList.toggle("hidden", !icons.length);
    return icons;
  }

  async function uploadIconFiles(files) {
    const list = Array.from(files || []).filter((f) =>
      /\.(png|svg)$/i.test(f.name)
    );
    if (!list.length) {
      toast("Only PNG or SVG files are allowed", "err");
      return;
    }
    const btn = $("#iconUploadBtn");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Uploading…";
    let ok = 0;
    for (const file of list) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const res = await fetch("/api/icons", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        ok++;
      } catch (e) {
        toast(`Upload failed (${file.name}): ${e.message}`, "err");
      }
    }
    btn.disabled = false;
    btn.textContent = label;
    if (ok) {
      toast(`Uploaded ${plural(ok, "icon")}. Restart Homepage to make them available.`, "ok");
      // Files can be dropped while another source is showing; land on them.
      $("#iconSearch").value = "";
      setIconSrc("uploads");
    }
  }

  async function deleteUpload(name) {
    if (!confirm(`Delete "${name}"? Services already using it will lose their icon.`)) return;
    try {
      const res = await fetch("/api/icons/" + encodeURIComponent(name), {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      toast("Deleted " + name, "info");
      runIconSearch();
    } catch (e) {
      toast("Delete error: " + e.message, "err");
    }
  }

  async function restartHomepage() {
    const btn = $("#restartHomepageBtn");
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = "Restarting…";
    try {
      const res = await fetch("/api/homepage/restart", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Restart failed");
      toast("Homepage is restarting — new icons will appear shortly.", "ok");
    } catch (e) {
      toast("Restart error: " + e.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  // Map an Iconify prefix:name to the best Homepage icon value + source badge.
  // The chooser's color control recolors monochrome sources (MDI, Simple Icons,
  // and generic SVGs); Font Awesome / dashboard icons keep their fixed color.
  function iconifyToHomepage(prefix, name) {
    const col = pickUseColor ? pickColor : null;
    if (prefix === "mdi") {
      return { value: col ? `mdi-${name}-${col}` : `mdi-${name}`, badge: "MDI" };
    }
    if (prefix === "fa6-solid") return { value: `fas-${name}`, badge: "FA" };
    if (prefix === "fa6-regular") return { value: `far-${name}`, badge: "FA" };
    if (prefix === "fa6-brands") return { value: `fab-${name}`, badge: "FA" };
    if (prefix === "simple-icons") {
      return { value: col ? `si-${name}-${col}` : `si-${name}`, badge: "SI" };
    }
    return { value: iconifyUrl(prefix, name), badge: "SVG" };
  }

  // Any Iconify icon as a direct SVG URL, recolored when the control is on.
  function iconifyUrl(prefix, name) {
    const url = `${ICONIFY}/${prefix}/${name}.svg`;
    return pickUseColor ? `${url}?color=${encodeURIComponent(pickColor)}` : url;
  }

  function chooseIcon(value) {
    $("#f_icon").value = value;
    updateEditorIconPreview();
    closeIconPicker();
  }

  async function ensureDashboardList() {
    if (dashboardList) return;
    const res = await fetch("/api/dashboard/tree");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load the dashboard icon index");
    dashboardList = (data.svg || []).slice();
  }

  // Search goes through our cache too: the upstream endpoint shares the rate
  // limit that made every preview fail.
  async function iconifySearch(query, { prefix = null, limit = 100 } = {}) {
    let u = `/api/iconify/search?query=${encodeURIComponent(query)}&limit=${limit}`;
    if (prefix) u += `&prefix=${encodeURIComponent(prefix)}`;
    const res = await fetch(u);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || "Icon search failed.");
      err.rateLimited = !!data.rateLimited;
      throw err;
    }
    return data.icons || [];
  }

  // ---- Save / preview / backups ----
  async function save() {
    const btn = $("#saveBtn");
    btn.disabled = true;
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exportPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      setDirty(false);
      toast("Saved." + (data.backup ? ` Backup: ${data.backup}` : ""), "ok");
    } catch (e) {
      toast("Save error: " + e.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  async function showPreview() {
    try {
      const res = await fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exportPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preview failed");
      openGeneric("YAML preview", `<pre></pre>`);
      $("#genericBody pre").textContent = data.yaml;
    } catch (e) {
      toast("Preview error: " + e.message, "err");
    }
  }

  async function showBackups() {
    try {
      const res = await fetch("/api/backups");
      const data = await res.json();
      const items = data.backups || [];
      const note = data.keep_days
        ? `<p class="hint">A backup is created on every save. Backups auto-purge after ${data.keep_days} days.</p>`
        : "";
      openGeneric("Backups", `${note}<ul class="backup-list"></ul>`);
      const ul = $("#genericBody .backup-list");
      if (!items.length) {
        ul.innerHTML = `<li class="muted">No backups yet. Backups are created on each save.</li>`;
        return;
      }
      items.forEach((b) => {
        const li = document.createElement("li");
        const when = new Date(b.mtime * 1000).toLocaleString();
        li.innerHTML = `<span class="bk-name"></span>
          <span class="bk-meta">${when} · ${(b.size / 1024).toFixed(1)} KB</span>
          <button class="btn ghost sm bk-restore">Restore</button>`;
        $(".bk-name", li).textContent = b.name;
        $(".bk-restore", li).addEventListener("click", () => restoreBackup(b.name));
        ul.appendChild(li);
      });
    } catch (e) {
      toast("Backups error: " + e.message, "err");
    }
  }

  async function restoreBackup(name) {
    if (!confirm(`Restore "${name}"? Your current file will be backed up first, then overwritten.`)) return;
    try {
      const res = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Restore failed");
      closeGeneric();
      await loadConfig();
      toast("Restored " + name, "ok");
    } catch (e) {
      toast("Restore error: " + e.message, "err");
    }
  }

  // ---- Changelog / release notes ----
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function renderInline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(
      /\[([^\]]+)\]\((https?:[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
    return s;
  }
  // Minimal Markdown → HTML for the subset used in CHANGELOG.md.
  function renderMarkdown(md) {
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };
    for (const raw of md.split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (/^\[[^\]]+\]:\s*https?:/i.test(line)) continue; // link reference defs
      let m;
      if ((m = line.match(/^#\s+(.*)/))) { closeList(); out.push(`<h1>${renderInline(m[1])}</h1>`); }
      else if ((m = line.match(/^##\s+(.*)/))) { closeList(); out.push(`<h2>${renderInline(m[1])}</h2>`); }
      else if ((m = line.match(/^###\s+(.*)/))) { closeList(); out.push(`<h3>${renderInline(m[1])}</h3>`); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push(`<li>${renderInline(m[1])}</li>`);
      } else if (line.trim() === "") { closeList(); }
      else { closeList(); out.push(`<p>${renderInline(line)}</p>`); }
    }
    closeList();
    return out.join("\n");
  }

  // ---- About ----
  // The links and copyright are server-rendered in the dialog; only the
  // release notes are fetched, and only once someone asks to read them.
  let notesLoaded = false;

  function openAbout() {
    $("#aboutOverlay").classList.remove("hidden");
  }
  function closeAbout() {
    $("#aboutOverlay").classList.add("hidden");
  }

  async function loadReleaseNotes() {
    if (notesLoaded) return;
    const body = $("#aboutNotesBody");
    try {
      const res = await fetch("/api/changelog");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      // Skip the file's preamble (what Keep a Changelog is, where the file
      // lives) and start at the first version — that's what a reader wants.
      const md = data.markdown || "";
      const firstVersion = md.search(/^## /m);
      body.innerHTML = renderMarkdown(firstVersion > 0 ? md.slice(firstVersion) : md);
      notesLoaded = true;
    } catch (e) {
      body.innerHTML = "";
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Couldn't load the release notes: " + e.message;
      body.appendChild(p);
    }
  }

  // ---- Homepage connection ----
  // Which services.yaml this edits, and which container "Restart Homepage"
  // restarts. Both are detected in the setup wizard; this is where they get
  // changed afterwards (and where a fresh install lands if the file moved).
  let connPicker = null;

  async function showConnection() {
    openGeneric(
      "Homepage connection",
      `<p class="hint">This editor writes to the file below. Pick a different one
         if it isn't the <code>services.yaml</code> your dashboard reads.</p>
       <div id="connMount"></div>
       <label class="field conn-field">
         <span>Homepage container <small class="muted">(what “Restart Homepage” restarts)</small></span>
         <input type="text" id="connContainer" spellcheck="false" autocomplete="off" placeholder="homepage" />
         <span class="hint" id="connContainerHint"></span>
       </label>
       <div class="conn-actions">
         <button class="btn primary" id="connSave">Save &amp; reload</button>
       </div>`
    );
    $("#connSave").addEventListener("click", saveConnection);

    connPicker = new ConnectionPicker($("#connMount"), {
      detectUrl: "/api/connection/detect",
      saveUrl: "/api/connection",
      csrf: CSRF,
    });

    try {
      const state = await (await fetch("/api/connection")).json();
      $("#connContainer").value = state.homepage_container || "";
    } catch (e) {
      /* the field just starts empty */
    }
    await connPicker.detect();

    // Docker often knows the container's real name better than the config does.
    const found = connPicker.data?.docker?.homepage?.name;
    const hint = $("#connContainerHint");
    if (hint && found && found !== $("#connContainer").value) {
      hint.innerHTML = `Detected <code></code> on this host · <button type="button" class="linklike">use it</button>`;
      $("code", hint).textContent = found;
      $("button", hint).addEventListener("click", () => {
        $("#connContainer").value = found;
        hint.textContent = "";
      });
    }
  }

  async function saveConnection() {
    if (dirty && !confirm("You have unsaved changes. Switching files discards them. Continue?")) return;
    const btn = $("#connSave");
    btn.disabled = true;
    try {
      const state = await connPicker.save({
        homepage_container: $("#connContainer").value.trim(),
      });
      const label = $("#cfgPath");
      label.textContent = state.services_path;
      label.title = state.services_path + " — click to change which file this edits";
      closeGeneric();
      setDirty(false);
      await loadConfig();
      toast("Now editing " + state.services_path, "ok");
    } catch (e) {
      // The picker reports its own errors inline, next to the choice.
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Generic modal ----
  function openGeneric(title, innerHtml) {
    $("#genericTitle").textContent = title;
    $("#genericBody").innerHTML = innerHtml;
    $("#genericOverlay").classList.remove("hidden");
  }
  function closeGeneric() { $("#genericOverlay").classList.add("hidden"); }

  // ---- Misc UI ----
  function setDirty(v) {
    dirty = v;
    $("#dirtyBadge").classList.toggle("hidden", !v);
  }

  function toast(msg, kind = "info") {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .3s, transform .3s";
      el.style.opacity = "0";
      el.style.transform = "translateX(30px)";
      setTimeout(() => el.remove(), 320);
    }, 3200);
  }

  function filterNav() {
    const q = $("#navFilter").value.trim().toLowerCase();
    $$("#sectionNav li").forEach((li) => {
      const g = groupById.get(li.dataset.gid);
      if (!g) return;
      const hay = (g.name + " " + (g.services || []).map((s) => s.name).join(" ")).toLowerCase();
      li.classList.toggle("dim", q && !hay.includes(q));
    });
  }

  // ---- Wire up ----
  function init() {
    $("#saveBtn").addEventListener("click", save);
    $("#reloadBtn").addEventListener("click", async () => {
      if (dirty && !confirm("Discard unsaved changes and reload from disk?")) return;
      await loadConfig();
    });
    $("#previewBtn").addEventListener("click", showPreview);
    $("#backupsBtn").addEventListener("click", showBackups);
    $("#addGroupBtn").addEventListener("click", addGroup);
    $("#emptyAddBtn").addEventListener("click", addGroup);
    $("#navFilter").addEventListener("input", filterNav);

    // Palette
    $$("#palette .palette-block").forEach((b) => {
      b.addEventListener("click", () => {
        if (b.dataset.kind === "group") addGroup();
        else {
          const g = state.groups.find((x) => x.type !== "raw");
          if (!g) { addGroup(); }
          const target = state.groups.find((x) => x.type !== "raw");
          if (target) addService(target);
        }
      });
    });
    Sortable.create($("#palette"), {
      group: { name: "services", pull: "clone", put: false },
      sort: false,
      draggable: '.palette-block[data-kind="service"]',
    });

    // Editor
    $("#editorClose").addEventListener("click", closeEditor);
    $("#editorCancel").addEventListener("click", closeEditor);
    $("#editorApply").addEventListener("click", applyEditor);
    $("#editorDelete").addEventListener("click", deleteFromEditor);
    $("#editorOverlay").addEventListener("click", (e) => {
      if (e.target.id === "editorOverlay") closeEditor();
    });
    $("#f_icon").addEventListener("input", updateEditorIconPreview);
    $("#f_icon_usecolor").addEventListener("change", applyIconColorFromUI);
    $("#f_icon_color").addEventListener("input", applyIconColorFromUI);
    $("#iconPickBtn").addEventListener("click", openIconPicker);
    $("#iconClearBtn").addEventListener("click", () => {
      $("#f_icon").value = "";
      updateEditorIconPreview();
    });

    // Icon chooser
    $("#iconModalClose").addEventListener("click", closeIconPicker);
    $("#iconOverlay").addEventListener("click", (e) => {
      if (e.target.id === "iconOverlay") closeIconPicker();
    });
    const sources = $$("#iconSources .src");
    sources.forEach((b, i) => {
      b.addEventListener("click", (e) => {
        if (b.dataset.src !== activeIconSrc) setIconSrc(b.dataset.src);
        // A mouse pick hands the keyboard back to the search; arrow keys
        // stay in the list.
        if (e.detail) $("#iconSearch").focus();
      });
      b.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = sources[(i + d + sources.length) % sources.length];
        next.focus();
        next.click();
      });
    });
    const search = $("#iconSearch");
    search.addEventListener("input", () => scheduleIconSearch());
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runIconSearch(); }
      else if (e.key === "ArrowDown") {
        const first = $("#iconResults .icon-cell:not(.is-skel)");
        if (first) { e.preventDefault(); first.focus(); }
      }
    });
    const results = $("#iconResults");
    results.addEventListener("click", (e) => {
      const del = e.target.closest(".cell-del");
      if (del) { deleteUpload(del.dataset.name); return; }
      const cell = e.target.closest(".icon-cell:not(.is-skel)");
      if (cell) chooseIcon(cell.dataset.value);
    });
    results.addEventListener("keydown", (e) => {
      const cell = e.target.closest(".icon-cell");
      if (!cell || e.target.closest(".cell-del")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseIcon(cell.dataset.value); }
      else if (e.key.startsWith("Arrow")) { e.preventDefault(); moveIconFocus(cell, e.key); }
    });
    $("#pickColorOn").addEventListener("change", (e) => {
      pickUseColor = e.target.checked;
      $("#pickColor").disabled = !pickUseColor;
      recolorIconCells();
    });
    $("#pickColor").addEventListener("input", (e) => {
      pickColor = e.target.value;
      if (pickUseColor) recolorIconCells();
    });

    // Uploads
    $("#iconUploadBtn").addEventListener("click", () => $("#iconUpload").click());
    $("#iconUpload").addEventListener("change", (e) => {
      uploadIconFiles(e.target.files);
      e.target.value = "";
    });
    $("#restartHomepageBtn").addEventListener("click", restartHomepage);
    $("#cfgPath").addEventListener("click", showConnection);

    // About
    $("#aboutBtn").addEventListener("click", openAbout);
    $("#aboutClose").addEventListener("click", closeAbout);
    $("#aboutOverlay").addEventListener("click", (e) => {
      if (e.target.id === "aboutOverlay") closeAbout();
    });
    $("#aboutNotes").addEventListener("toggle", (e) => {
      if (e.target.open) loadReleaseNotes();
    });
    // Files dropped anywhere on the results pane upload, whichever source
    // is showing.
    const pane = $("#iconPane");
    const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    pane.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      $("#iconDrop").classList.remove("hidden");
    });
    pane.addEventListener("dragleave", (e) => {
      if (!pane.contains(e.relatedTarget)) $("#iconDrop").classList.add("hidden");
    });
    pane.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      $("#iconDrop").classList.add("hidden");
      uploadIconFiles(e.dataTransfer.files);
    });

    // Generic modal
    $("#genericClose").addEventListener("click", closeGeneric);
    $("#genericOverlay").addEventListener("click", (e) => {
      if (e.target.id === "genericOverlay") closeGeneric();
    });

    // Keyboard
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        if (!$("#iconOverlay").classList.contains("hidden")) closeIconPicker();
        else if (!$("#editorOverlay").classList.contains("hidden")) closeEditor();
        else if (!$("#aboutOverlay").classList.contains("hidden")) closeAbout();
        else if (!$("#genericOverlay").classList.contains("hidden")) closeGeneric();
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    loadConfig();
  }

  // Wait for deferred CDN libs (Sortable, jsyaml) to be ready.
  function boot() {
    if (window.Sortable && window.jsyaml) init();
    else setTimeout(boot, 50);
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
