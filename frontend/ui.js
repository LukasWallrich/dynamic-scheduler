/* ============================================================
   Shared UI helpers: DOM building, timezone-aware formatting,
   reusable controls (vote segmented control, typeahead timezone
   select), toasts, and the client-side feasibility preview that
   reuses window.Sched (core) so votes get an instant "reaches N"
   hint with no round-trip. The server stays authoritative.
   ============================================================ */
(function () {
  "use strict";
  var App = window.App = window.App || {};
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  /* ---------- DOM builder ---------- */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
      else node.setAttribute(k, v === true ? "" : v);
    });
    (Array.isArray(children) ? children : children != null ? [children] : []).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function mount(children) {
    var app = document.getElementById("app");
    clear(app);
    (Array.isArray(children) ? children : [children]).forEach(function (c) { if (c) app.appendChild(c); });
    return app;
  }

  /* ---------- timezone-aware formatting ----------
     Slots are UTC instants; we render them in the event timezone and,
     when it differs, in the viewer's own timezone (DESIGN: dual display). */
  function viewerTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return "UTC"; } }

  function parts(utcMs, tz) {
    var dtf = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    var p = {};
    dtf.formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function fmtDay(utcMs, tz) { var p = parts(utcMs, tz); return p.weekday + " " + p.day + " " + p.month; }
  function fmtTime(utcMs, tz) { var p = parts(utcMs, tz); return p.hour + ":" + p.minute; }
  function fmtRange(startUtc, endUtc, tz) { return fmtTime(startUtc, tz) + "–" + fmtTime(endUtc, tz); }
  function fmtFull(startUtc, endUtc, tz) { return fmtDay(startUtc, tz) + " · " + fmtRange(startUtc, endUtc, tz); }
  function fmtDeadline(utcMs, tz) {
    if (!utcMs) return "";
    var p = parts(utcMs, tz);
    return p.weekday + " " + p.day + " " + p.month + ", " + p.hour + ":" + p.minute;
  }
  function tzAbbrev(tz) { return tz.split("/").pop().replace(/_/g, " "); }

  /* Renders a slot's time block: event-local always; viewer-local if it differs. */
  function whenBlock(slot, tz) {
    var vt = viewerTz();
    var kids = [
      el("span", { class: "d" }, fmtDay(slot.startUtc, tz)),
      el("span", { class: "h" }, " " + fmtRange(slot.startUtc, slot.endUtc, tz))
    ];
    if (vt !== tz) kids.push(el("span", { class: "viewer-tz" }, "Your time: " + fmtRange(slot.startUtc, slot.endUtc, vt) + " (" + tzAbbrev(vt) + ")"));
    return el("span", { class: "when" }, kids);
  }

  /* ---------- vote segmented control (Works / If needed / Can't) ---------- */
  function voteControl(current, onChange, opts) {
    opts = opts || {};
    var order = [["works", "Works"], ["ifneeded", opts.shortIf ? "If" : "If needed"], ["cant", "Can’t"]];
    var group = el("span", { class: "votes", role: "group" });
    order.forEach(function (pair) {
      var val = pair[0];
      var btn = el("button", {
        type: "button", class: "vbtn " + val, "aria-pressed": current === val ? "true" : "false",
        disabled: opts.disabled || undefined
      }, pair[1]);
      btn.addEventListener("click", function () {
        Array.prototype.forEach.call(group.children, function (b) { b.setAttribute("aria-pressed", "false"); });
        btn.setAttribute("aria-pressed", "true");
        onChange(val);
      });
      group.appendChild(btn);
    });
    return group;
  }

  /* ---------- typeahead timezone select ---------- */
  function timezoneList() {
    try { if (Intl.supportedValuesOf) return Intl.supportedValuesOf("timeZone"); } catch (e) {}
    return ["UTC", "Europe/London", "Europe/Berlin", "Europe/Paris", "America/New_York",
      "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Tokyo", "Asia/Kolkata",
      "Asia/Singapore", "Australia/Sydney", "Africa/Lagos"];
  }
  function timezoneSelect(value, onChange) {
    var zones = timezoneList();
    var wrap = el("div", { class: "combo" });
    var input = el("input", { type: "text", value: value || "", autocomplete: "off",
      role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", placeholder: "Search timezones…" });
    var list = el("div", { class: "options", role: "listbox" });
    var chosen = value || "";
    wrap.appendChild(input); wrap.appendChild(list);

    function render(filter) {
      clear(list);
      var f = (filter || "").toLowerCase().replace(/\s+/g, "_");
      var matches = zones.filter(function (z) { return z.toLowerCase().indexOf(f) !== -1; }).slice(0, 60);
      if (!matches.length) { list.appendChild(el("div", { class: "opt none" }, "No matching timezone")); return; }
      matches.forEach(function (z) {
        var opt = el("div", { class: "opt" + (z === chosen ? " active" : ""), role: "option" }, z.replace(/_/g, " "));
        opt.addEventListener("mousedown", function (e) {
          e.preventDefault();
          chosen = z; input.value = z.replace(/_/g, " ");
          wrap.classList.remove("open"); input.setAttribute("aria-expanded", "false");
          onChange(z);
        });
        list.appendChild(opt);
      });
    }
    input.addEventListener("focus", function () { wrap.classList.add("open"); input.setAttribute("aria-expanded", "true"); render(input.value); });
    input.addEventListener("input", function () { wrap.classList.add("open"); render(input.value); });
    input.addEventListener("blur", function () { setTimeout(function () { wrap.classList.remove("open"); input.setAttribute("aria-expanded", "false"); if (chosen) input.value = chosen.replace(/_/g, " "); }, 120); });
    if (value) input.value = value.replace(/_/g, " ");
    return { node: wrap, get: function () { return chosen; } };
  }

  /* ---------- stepper ---------- */
  function stepper(value, min, max, onChange) {
    var val = value;
    var input = el("input", { type: "number", value: val, min: min, max: max, "aria-label": "value" });
    function set(v) { val = Math.max(min, Math.min(max, v)); input.value = val; onChange(val); }
    input.addEventListener("change", function () { set(parseInt(input.value, 10) || min); });
    return el("div", { class: "stepper" }, [
      el("button", { type: "button", "aria-label": "decrease", onclick: function () { set(val - 1); } }, "−"),
      input,
      el("button", { type: "button", "aria-label": "increase", onclick: function () { set(val + 1); } }, "+")
    ]);
  }

  /* ---------- toast + banners ---------- */
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  function banner(kind, msg) { return el("div", { class: "banner-info banner-" + kind }, msg); }

  /* ---------- client-side feasibility preview (reuses core) ----------
     Given a slot's anonymous support counts (present under neutral
     visibility) plus the viewer's pending vote, synthesise a minimal
     snapshot and run Sched.engine to show an instant "reaches N" hint.
     Falls back to a plain count if core is unavailable. */
  function coreReady() { return !window.__noCore && window.Sched && window.Sched.engine && window.Sched.votes; }

  function reachPreview(poll, support, yourVote) {
    // support: server counts INCLUDING the viewer's currently recorded vote (may be null).
    // Build attending = works + ifneeded, swapping the viewer's contribution for `yourVote`.
    if (!support) return null;
    var s = { works: support.works || 0, ifneeded: support.ifneeded || 0, cant: support.cant || 0 };

    if (coreReady()) {
      // Synthesise anonymous invitees from the counts and re-run the engine's success rule.
      var invitees = [], votes = [], id = 0;
      function add(answer) {
        var iid = "a" + (id++);
        invitees.push({ inviteeId: iid, name: iid, required: false });
        if (answer) votes.push({ inviteeId: iid, slotId: "s", answer: answer, rev: 1, atUtc: 1 });
      }
      s.works && repeat(s.works, function () { add("works"); });
      s.ifneeded && repeat(s.ifneeded, function () { add("ifneeded"); });
      s.cant && repeat(s.cant, function () { add("cant"); });
      // the viewer
      invitees.push({ inviteeId: "you", name: "you", required: false });
      if (yourVote) votes.push({ inviteeId: "you", slotId: "s", answer: yourVote, rev: 2, atUtc: 2 });
      var snap = {
        poll: { minAttendees: poll.minAttendees || 1, maxAbsences: poll.maxAbsences != null ? poll.maxAbsences : 99,
                tz: poll.tz, slateVersion: 1 },
        invitees: invitees,
        slots: [{ slotId: "s", startUtc: 0, endUtc: 0, kind: "slate1", slateVersion: 1 }],
        votes: votes, constraints: []
      };
      var t = Sched.votes.counts(snap, "s");
      var attending = t.works + t.ifneeded;
      var bookable = Sched.engine.feasible(snap, "s", false);
      return { attending: attending, bookable: bookable, min: snap.poll.minAttendees };
    }
    // no-core fallback
    var attending2 = s.works + s.ifneeded + (yourVote === "works" || yourVote === "ifneeded" ? 1 : 0);
    return { attending: attending2, bookable: null, min: poll.minAttendees || 1 };
  }
  function repeat(n, fn) { for (var i = 0; i < n; i++) fn(); }

  /* ---------- theme (respects prefers-color-scheme; ?theme= overrides) ---------- */
  function applyTheme() {
    var qs = new URLSearchParams(window.location.search);
    var t = qs.get("theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  }

  App.ui = {
    el: el, clear: clear, mount: mount, DOW: DOW,
    viewerTz: viewerTz, fmtDay: fmtDay, fmtTime: fmtTime, fmtRange: fmtRange, fmtFull: fmtFull,
    fmtDeadline: fmtDeadline, tzAbbrev: tzAbbrev, whenBlock: whenBlock, parts: parts,
    voteControl: voteControl, timezoneSelect: timezoneSelect, timezoneList: timezoneList,
    stepper: stepper, toast: toast, banner: banner, reachPreview: reachPreview,
    coreReady: coreReady, applyTheme: applyTheme
  };
})();
