/* Homepage connection picker — "where is your services.yaml?"
 *
 * Shared by the first-run wizard and the in-app connection dialog, because
 * both ask exactly the same question. The server does the finding (see
 * discovery.py); this renders the candidates, explains why each one showed up,
 * and posts the chosen path back.
 */
(() => {
  "use strict";

  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  function composeSnippet(hostDir) {
    return `volumes:\n  - ${hostDir}:/config`;
  }

  class ConnectionPicker {
    /**
     * @param {HTMLElement} root     container to render into
     * @param {object} opts
     *   detectUrl  where to GET detection results
     *   saveUrl    where to POST the choice (null = selection only)
     *   csrf       CSRF token for the POST
     *   compact    trim the explanatory copy (in-app dialog)
     */
    constructor(root, opts = {}) {
      this.root = root;
      this.opts = opts;
      this.data = null;
      this.selected = null;
      this.manual = "";
      this.root.classList.add("conn");
      this.root.innerHTML = `
        <div class="conn-status" data-role="status">Looking for your Homepage config…</div>
        <div class="conn-docker" data-role="docker" hidden></div>
        <div class="conn-list" data-role="list"></div>
        <div class="conn-note sel" data-role="selnote" hidden></div>
        <div class="conn-error" data-role="error" hidden></div>
        <div class="conn-foot">
          <button type="button" class="btn ghost sm" data-role="rescan">↻ Scan again</button>
        </div>`;
      this.$ = (role) => this.root.querySelector(`[data-role="${role}"]`);
      this.$("rescan").addEventListener("click", () => this.detect(true));
      // Bound once: the list is re-filled on every render, not replaced.
      this.$("list").addEventListener("change", (e) => {
        if (e.target.name === "conn-choice") this.select(e.target.value);
      });
    }

    /** Current selection, or "" when nothing usable is picked. */
    get path() {
      return (this.selected === "__manual__" ? this.manual : this.selected) || "";
    }

    async detect(refresh = false) {
      const status = this.$("status");
      status.textContent = refresh ? "Scanning again…" : "Looking for your Homepage config…";
      status.className = "conn-status busy";
      this.$("rescan").disabled = true;
      try {
        const url = this.opts.detectUrl + (refresh ? "?refresh=1" : "");
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Detection failed.");
        this.data = data;
        this.render();
      } catch (e) {
        status.className = "conn-status bad";
        status.textContent = "Couldn't scan for config files: " + e.message;
        this.renderList([]); // manual entry is still offered
      } finally {
        this.$("rescan").disabled = false;
      }
    }

    render() {
      const d = this.data || {};
      const candidates = d.candidates || [];
      const status = this.$("status");

      // Only files that actually exist count as "found" — the list also
      // carries the default path, which is a place to create one, not a find.
      const real = candidates.filter((c) => c.exists);

      if (real.length) {
        status.className = "conn-status good";
        status.textContent =
          real.length === 1
            ? "Found your Homepage config."
            : `Found ${real.length} possible locations — the most likely one is selected.`;
      } else if (d.unmounted_host_config_dir) {
        status.className = "conn-status warn";
        status.textContent =
          "Homepage is running here, but its config folder isn't shared with this container yet.";
      } else {
        status.className = "conn-status warn";
        status.textContent =
          "No services.yaml in anything mounted into this container — pick where one should be created, or type its path.";
      }

      this.renderDocker(d);
      this.renderList(candidates);
    }

    renderDocker(d) {
      const box = this.$("docker");
      const docker = d.docker || {};
      const bits = [];

      if (docker.homepage) {
        const hp = docker.homepage;
        bits.push(
          `<p class="conn-note ok">Found your Homepage container:
             <code>${esc(hp.name)}</code>
             <span class="muted">${esc(hp.image || "")}${
               hp.state && hp.state !== "running" ? " · " + esc(hp.state) : ""
             }</span></p>`
        );
      } else if (docker.available) {
        bits.push(
          `<p class="conn-note">No Homepage container found on this Docker host —
             that's fine if Homepage runs elsewhere or outside Docker.</p>`
        );
      } else {
        bits.push(
          `<p class="conn-note">The Docker socket isn't mounted, so this can only
             search the folders already mounted into this container. Mount
             <code>/var/run/docker.sock</code> to let it find Homepage by itself.</p>`
        );
      }

      // The most useful thing we can say: Homepage is right there, but its
      // config directory isn't shared with us, and here is the exact fix.
      if (d.unmounted_host_config_dir) {
        bits.push(
          `<div class="conn-fix">
             <p><strong>Homepage's config lives at</strong>
               <code>${esc(d.unmounted_host_config_dir)}</code> on the host, but
               that folder isn't mounted into this container yet.</p>
             <p class="hint">Add it to this app's service in your compose file, then
               recreate the container and scan again:</p>
             <pre><code>${esc(composeSnippet(d.unmounted_host_config_dir))}</code></pre>
           </div>`
        );
      }

      box.innerHTML = bits.join("");
      box.hidden = !bits.length;
    }

    renderList(candidates) {
      const list = this.$("list");
      list.innerHTML = "";
      const current = (this.data && this.data.current) || {};

      candidates.forEach((c, i) => {
        const tags = [];
        if (i === 0 && candidates.length > 1) tags.push(`<em class="conn-tag best">Best match</em>`);
        if ((c.sources || []).includes("docker")) tags.push(`<em class="conn-tag ok">Homepage's config</em>`);
        if (c.path === current.services_path) tags.push(`<em class="conn-tag">In use</em>`);
        if (!c.exists) tags.push(`<em class="conn-tag warn">Will be created</em>`);
        else if (!c.writable) tags.push(`<em class="conn-tag bad">Read-only</em>`);

        const meta = [];
        if (c.exists && c.size != null) meta.push(`${(c.size / 1024).toFixed(1)} KB`);
        if (c.mtime) meta.push(`edited ${new Date(c.mtime * 1000).toLocaleDateString()}`);

        const item = el(`
          <label class="conn-item">
            <input type="radio" name="conn-choice" value="${esc(c.path)}" />
            <span class="conn-body">
              <span class="conn-path">${esc(c.path)}</span>
              ${c.host_path && c.host_path !== c.path
                ? `<span class="conn-host">on the host: <code>${esc(c.host_path)}</code></span>`
                : ""}
              <span class="conn-why">${esc(c.reason || "")}${
                meta.length ? " · " + esc(meta.join(" · ")) : ""
              }</span>
              <span class="conn-tags">${tags.join("")}</span>
            </span>
          </label>`);
        list.appendChild(item);
      });

      // Always offer an escape hatch — someone can know better than the scan.
      const manual = el(`
        <label class="conn-item conn-manual">
          <input type="radio" name="conn-choice" value="__manual__" />
          <span class="conn-body">
            <span class="conn-path">Somewhere else…</span>
            <span class="conn-why">Type the path as this container sees it.</span>
            <input type="text" class="conn-input" data-role="manual-input" spellcheck="false"
                   placeholder="/config/services.yaml" />
          </span>
        </label>`);
      list.appendChild(manual);

      const input = manual.querySelector('[data-role="manual-input"]');
      input.value = this.manual;
      input.addEventListener("input", () => {
        this.manual = input.value.trim();
        this.select("__manual__", { keepFocus: true });
      });
      input.addEventListener("focus", () => this.select("__manual__", { keepFocus: true }));

      const preferred = candidates.length ? candidates[0].path : "__manual__";
      this.select(this.path && this.path !== "__manual__" ? this.path : preferred);
    }

    select(value, { keepFocus = false } = {}) {
      this.selected = value;
      this.root.querySelectorAll('input[name="conn-choice"]').forEach((r) => {
        const on = r.value === value;
        r.checked = on;
        r.closest(".conn-item").classList.toggle("is-selected", on);
      });
      const input = this.$("manual-input");
      if (input && value === "__manual__" && !keepFocus) input.focus();
      this.error(null);
      this.renderSelectionNote();
      if (this.opts.onChange) this.opts.onChange(this.path);
    }

    /** What picking *this* file means — read-only, or about to be created. */
    renderSelectionNote() {
      const note = this.$("selnote");
      if (!note) return;
      const chosen = (this.data?.candidates || []).find((c) => c.path === this.path);
      let text = "";
      if (chosen && chosen.exists && !chosen.writable) {
        text =
          "This container can only read that file, so saving will fail until the mount " +
          "or the file's permissions allow writing.";
      } else if (chosen && !chosen.exists) {
        text = "There's no file there yet — an empty services.yaml will be created.";
      }
      note.textContent = text;
      note.className = "conn-note sel" + (chosen && chosen.exists && !chosen.writable ? " bad" : "");
      note.hidden = !text;
    }

    error(message) {
      const box = this.$("error");
      box.textContent = message || "";
      box.hidden = !message;
    }

    /**
     * Persist the selection. Resolves with the new connection state.
     *
     * An offered location that doesn't exist yet is created without asking —
     * its card already says "Will be created". A hand-typed path gets one
     * confirmation, since an absent file there is more likely to be a typo.
     */
    async save(extra = {}) {
      const path = this.path;
      if (!path) {
        this.error("Pick a location, or type one in.");
        throw new Error("no selection");
      }
      const post = (body) =>
        fetch(this.opts.saveUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF": this.opts.csrf || "" },
          body: JSON.stringify(body),
        }).then((res) => res.json().then((data) => ({ res, data })));

      const offered = (this.data?.candidates || []).find((c) => c.path === path);
      let { res, data } = await post({ path, create: !!offered && !offered.exists, ...extra });
      if (!res.ok && data.can_create) {
        if (!window.confirm(`There's no file at ${path} yet.\n\nCreate an empty services.yaml there?`)) {
          this.error("Pick an existing file, or allow the empty one to be created.");
          throw new Error("declined");
        }
        ({ res, data } = await post({ path, create: true, ...extra }));
      }
      if (!res.ok) {
        this.error(data.error || "Couldn't save that path.");
        throw new Error(data.error || "save failed");
      }
      this.error(null);
      return data;
    }
  }

  window.ConnectionPicker = ConnectionPicker;
})();
