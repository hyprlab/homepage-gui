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

  // ---- Icon string -> preview URL resolution ----
  const ICONIFY = "https://api.iconify.design";
  const DASH = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
  const SELFHST = "https://cdn.jsdelivr.net/gh/selfhst/icons";

  // Homepage supports a trailing `-#hexcolor` on mdi/si/sh icons.
  const COLOR_PREFIXES = ["mdi", "si", "sh"];

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

  function iconToUrl(icon, { height = 32, color = null } = {}) {
    if (!icon) return null;
    icon = String(icon).trim();
    if (!icon) return null;
    if (/^https?:\/\//i.test(icon)) return icon;
    // Root-relative (e.g. /icons/foo.png) — Homepage serves these, and so does
    // this app at the same path, so previews resolve against our own origin.
    if (icon.startsWith("/")) return icon;

    // Dashboard icons: name.svg / name.png / name.webp
    let m = icon.match(/^(.+)\.(svg|png|webp)$/i);
    if (m) {
      const ext = m[2].toLowerCase();
      const folder = ext === "svg" ? "svg" : ext === "png" ? "png" : "webp";
      return `${DASH}/${folder}/${icon}`;
    }

    // Material Design Icons: mdi-name or mdi-name-#hexcolor
    m = icon.match(/^mdi-(.+)$/i);
    if (m) {
      const { base, color: c } = splitColorSuffix(m[1]);
      return iconifyUrl("mdi", base, { height, color: c || color });
    }

    // Simple Icons: si-name or si-name-#hexcolor
    m = icon.match(/^si-(.+)$/i);
    if (m) {
      const { base, color: c } = splitColorSuffix(m[1]);
      return iconifyUrl("simple-icons", base, { height, color: c || color });
    }

    // Selfh.st icons (color suffix supported by Homepage, but not in the preview)
    m = icon.match(/^sh-(.+)$/i);
    if (m) {
      const { base } = splitColorSuffix(m[1]);
      return `${SELFHST}/svg/${base.replace(/\.(svg|png)$/, "")}.svg`;
    }

    // Font Awesome: fas- far- fab- fal- fad- fa-
    m = icon.match(/^(fas|far|fab|fal|fad|fa)-(.+)$/i);
    if (m) {
      const set = faSet(m[1].toLowerCase());
      return iconifyUrl(set, m[2], { height, color });
    }

    // prefix:name (raw iconify)
    m = icon.match(/^([a-z0-9-]+):([a-z0-9-]+)$/i);
    if (m) return iconifyUrl(m[1], m[2], { height, color });

    return null;
  }

  function faSet(prefix) {
    switch (prefix) {
      case "fab": return "fa6-brands";
      case "far": case "fal": return "fa6-regular";
      default: return "fa6-solid"; // fa, fas, fad
    }
  }

  function iconifyUrl(prefix, name, { height = 32, color = null } = {}) {
    let u = `${ICONIFY}/${prefix}/${name}.svg?height=${height}`;
    if (color) u += `&color=${encodeURIComponent(color)}`;
    return u;
  }

  function setIconImg(imgEl, fallbackEl, icon, opts) {
    const url = iconToUrl(icon, opts);
    if (!url) {
      imgEl.removeAttribute("src");
      imgEl.style.display = "none";
      if (fallbackEl) fallbackEl.style.display = "";
      return;
    }
    imgEl.style.display = "";
    if (fallbackEl) fallbackEl.style.display = "none";
    imgEl.onerror = () => {
      imgEl.removeAttribute("src");
      imgEl.style.display = "none";
      if (fallbackEl) fallbackEl.style.display = "";
    };
    imgEl.src = url;
  }

  // ---- Load / build state ----
  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
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
    setIconImg($(".svc-icon img", node), $(".svc-icon .icon-fallback", node), cfg.icon, { height: 28 });
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
    setIconImg($("#iconPreview"), $("#iconPreviewFallback"), $("#f_icon").value, { height: 32 });
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
  let activeIconSrc = "all";
  let dashboardList = null;
  let mdiColor = "#3b82f6";
  let mdiUseColor = true;
  let searchSeq = 0;

  function openIconPicker() {
    $("#iconOverlay").classList.remove("hidden");
    setIconSrc(activeIconSrc);
    setTimeout(() => $("#iconSearch").focus(), 30);
  }
  function closeIconPicker() { $("#iconOverlay").classList.add("hidden"); }

  function setIconSrc(src) {
    activeIconSrc = src;
    $$("#iconTabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.src === src));
    $("#mdiColorWrap").classList.toggle("hidden", !["mdi", "svg", "all"].includes(src));
    $("#freesvgLink").classList.toggle("hidden", src !== "svg" && src !== "all");
    $("#uploadControls").classList.toggle("hidden", src !== "uploads");
    $("#iconSearch").placeholder = src === "uploads" ? "Filter your uploads…" : "Search icons…";
    runIconSearch();
  }

  let searchTimer = null;
  function scheduleIconSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runIconSearch, 220);
  }

  async function runIconSearch() {
    const q = $("#iconSearch").value.trim();
    const seq = ++searchSeq;
    const results = $("#iconResults");
    const status = $("#iconStatus");
    results.innerHTML = "";

    try {
      if (activeIconSrc === "uploads") {
        const res = await fetch("/api/icons");
        const data = await res.json();
        if (seq !== searchSeq) return;
        const icons = (data.icons || []).filter(
          (it) => !q || it.name.toLowerCase().includes(q.toLowerCase())
        );
        if (!icons.length) {
          status.textContent = q
            ? "No matching uploads."
            : "No custom icons yet. Upload a PNG or SVG, then restart Homepage to use them.";
        } else {
          status.textContent =
            `${icons.length} custom icon(s). Select one, then restart Homepage so it serves new files.`;
        }
        icons.forEach((it) => addUploadCell(it));
        return;
      }
      if (activeIconSrc === "all") {
        if (!q) {
          status.textContent = "Search across Dashboard, MDI, Font Awesome, Simple Icons and any SVG at once.";
          return;
        }
        await ensureDashboardList();
        const dash = dashboardList
          .filter((n) => n.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 24);
        const icons = await iconifySearch(q, { limit: 120 });
        if (seq !== searchSeq) return;
        dash.forEach((n) =>
          addIconCell(`${DASH}/svg/${n}`, n.replace(/\.svg$/, ""), n, "DASH")
        );
        icons.forEach((full) => {
          const [prefix, name] = full.split(":");
          const mapped = iconifyToHomepage(prefix, name);
          addIconCell(mapped.preview, name, mapped.value, mapped.badge);
        });
        status.textContent = `${dash.length + icons.length} result(s) across all sources`;
      } else if (activeIconSrc === "dashboard") {
        await ensureDashboardList();
        const names = dashboardList
          .filter((n) => !q || n.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 200);
        if (seq !== searchSeq) return;
        status.textContent = `${names.length} dashboard icon(s)${q ? "" : " (type to filter)"}`;
        names.forEach((n) => {
          const value = n; // already like "plex.svg"
          addIconCell(`${DASH}/svg/${n}`, n.replace(/\.svg$/, ""), value, "DASH");
        });
      } else if (activeIconSrc === "mdi") {
        if (!q) { status.textContent = "Type to search Material Design Icons…"; return; }
        const icons = await iconifySearch(q, { prefix: "mdi", limit: 120 });
        if (seq !== searchSeq) return;
        status.textContent = `${icons.length} MDI result(s)`;
        icons.forEach((full) => {
          const name = full.split(":")[1];
          const col = mdiUseColor ? mdiColor : null;
          const value = mdiUseColor ? `mdi-${name}-${mdiColor}` : `mdi-${name}`;
          addIconCell(iconifyUrl("mdi", name, { height: 32, color: col }), name, value, "MDI");
        });
      } else if (activeIconSrc === "fa") {
        if (!q) { status.textContent = "Type to search Font Awesome (free) icons…"; return; }
        const sets = [
          ["fa6-solid", "fas"],
          ["fa6-regular", "far"],
          ["fa6-brands", "fab"],
        ];
        const all = await Promise.all(
          sets.map(([p]) => iconifySearch(q, { prefix: p, limit: 48 }))
        );
        if (seq !== searchSeq) return;
        let count = 0;
        all.forEach((icons, i) => {
          const [prefix, hpPrefix] = sets[i];
          icons.forEach((full) => {
            const name = full.split(":")[1];
            count++;
            addIconCell(iconifyUrl(prefix, name, { height: 32 }), `${hpPrefix}-${name}`, `${hpPrefix}-${name}`, "FA");
          });
        });
        status.textContent = `${count} Font Awesome result(s)`;
      } else if (activeIconSrc === "svg") {
        if (!q) { status.textContent = "Search 200k+ SVG icons (Iconify). Stored as a direct URL; tick Color to override a monochrome icon's color."; return; }
        const icons = await iconifySearch(q, { limit: 120 });
        if (seq !== searchSeq) return;
        const col = mdiUseColor ? mdiColor : null;
        status.textContent =
          `${icons.length} SVG result(s) — stored as a direct URL` +
          (col ? ` recolored ${col}` : "");
        icons.forEach((full) => {
          const [prefix, name] = full.split(":");
          const url = col
            ? `${ICONIFY}/${prefix}/${name}.svg?color=${encodeURIComponent(col)}`
            : `${ICONIFY}/${prefix}/${name}.svg`;
          addIconCell(iconifyUrl(prefix, name, { height: 32, color: col }), full, url, "SVG");
        });
      }
      if (!results.children.length && q) status.textContent = "No icons found.";
    } catch (e) {
      if (seq === searchSeq) status.textContent = "Search error: " + e.message;
    }
  }

  function addIconCell(previewUrl, label, value, badge) {
    const cell = document.createElement("div");
    cell.className = "icon-cell";
    cell.title = value;
    if (badge) {
      const b = document.createElement("span");
      b.className = "cell-badge b-" + badge.toLowerCase();
      b.textContent = badge;
      cell.appendChild(b);
    }
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = previewUrl;
    img.alt = label;
    img.onerror = () => cell.remove();
    const lab = document.createElement("span");
    lab.className = "cell-label";
    lab.textContent = label;
    cell.appendChild(img);
    cell.appendChild(lab);
    cell.addEventListener("click", () => chooseIcon(value));
    $("#iconResults").appendChild(cell);
  }

  function addUploadCell(item) {
    const cell = document.createElement("div");
    cell.className = "icon-cell";
    cell.title = item.ref;

    const del = document.createElement("button");
    del.className = "cell-del";
    del.textContent = "✕";
    del.title = "Delete this upload";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteUpload(item.name);
    });
    cell.appendChild(del);

    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = item.ref; // served by this app at /icons/<name>
    img.alt = item.name;
    const lab = document.createElement("span");
    lab.className = "cell-label";
    lab.textContent = item.name;
    cell.appendChild(img);
    cell.appendChild(lab);
    cell.addEventListener("click", () => chooseIcon(item.ref));
    $("#iconResults").appendChild(cell);
  }

  async function uploadIconFiles(files) {
    const list = Array.from(files || []).filter((f) =>
      /\.(png|svg)$/i.test(f.name)
    );
    if (!list.length) {
      toast("Only PNG or SVG files are allowed", "err");
      return;
    }
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
    if (ok) {
      toast(
        `Uploaded ${ok} icon(s). Restart Homepage to make them available.`,
        "ok"
      );
      if (activeIconSrc === "uploads") runIconSearch();
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
    const col = mdiUseColor ? mdiColor : null;
    if (prefix === "mdi") {
      const value = col ? `mdi-${name}-${col}` : `mdi-${name}`;
      return { value, badge: "MDI", preview: iconifyUrl("mdi", name, { height: 32, color: col }) };
    }
    if (prefix === "fa6-solid") return { value: `fas-${name}`, badge: "FA", preview: iconifyUrl(prefix, name, { height: 32 }) };
    if (prefix === "fa6-regular") return { value: `far-${name}`, badge: "FA", preview: iconifyUrl(prefix, name, { height: 32 }) };
    if (prefix === "fa6-brands") return { value: `fab-${name}`, badge: "FA", preview: iconifyUrl(prefix, name, { height: 32 }) };
    if (prefix === "simple-icons") {
      const value = col ? `si-${name}-${col}` : `si-${name}`;
      return { value, badge: "SI", preview: iconifyUrl(prefix, name, { height: 32, color: col }) };
    }
    const url = col
      ? `${ICONIFY}/${prefix}/${name}.svg?color=${encodeURIComponent(col)}`
      : `${ICONIFY}/${prefix}/${name}.svg`;
    return { value: url, badge: "SVG", preview: iconifyUrl(prefix, name, { height: 32, color: col }) };
  }

  function chooseIcon(value) {
    $("#f_icon").value = value;
    updateEditorIconPreview();
    closeIconPicker();
  }

  async function ensureDashboardList() {
    if (dashboardList) return;
    const res = await fetch(`${DASH}@main/tree.json`);
    const data = await res.json();
    dashboardList = (data.svg || []).slice();
  }

  async function iconifySearch(query, { prefix = null, limit = 100 } = {}) {
    let u = `${ICONIFY}/search?query=${encodeURIComponent(query)}&limit=${limit}`;
    if (prefix) u += `&prefix=${prefix}`;
    const res = await fetch(u);
    const data = await res.json();
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

  async function showChangelog() {
    try {
      const res = await fetch("/api/changelog");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      openGeneric("Release notes", `<div class="changelog"></div>`);
      $("#genericBody .changelog").innerHTML = renderMarkdown(data.markdown || "");
    } catch (e) {
      toast("Changelog error: " + e.message, "err");
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
    $$("#iconTabs .tab").forEach((t) =>
      t.addEventListener("click", () => setIconSrc(t.dataset.src))
    );
    $("#iconSearch").addEventListener("input", scheduleIconSearch);
    $("#mdiColor").addEventListener("input", (e) => {
      mdiColor = e.target.value;
      mdiUseColor = true;
      runIconSearch();
    });
    $("#mdiColorNone").addEventListener("click", () => {
      mdiUseColor = !mdiUseColor;
      $("#mdiColorNone").textContent = mdiUseColor ? "None" : "Color";
      runIconSearch();
    });

    // Uploads
    $("#iconUploadBtn").addEventListener("click", () => $("#iconUpload").click());
    $("#iconUpload").addEventListener("change", (e) => {
      uploadIconFiles(e.target.files);
      e.target.value = "";
    });
    $("#restartHomepageBtn").addEventListener("click", restartHomepage);
    $("#changelogBtn").addEventListener("click", showChangelog);
    // Drag-and-drop upload onto the results area while on the Uploads tab.
    const results = $("#iconResults");
    results.addEventListener("dragover", (e) => {
      if (activeIconSrc !== "uploads") return;
      e.preventDefault();
      results.classList.add("dropzone");
    });
    results.addEventListener("dragleave", () => results.classList.remove("dropzone"));
    results.addEventListener("drop", (e) => {
      if (activeIconSrc !== "uploads") return;
      e.preventDefault();
      results.classList.remove("dropzone");
      if (e.dataTransfer && e.dataTransfer.files) uploadIconFiles(e.dataTransfer.files);
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
