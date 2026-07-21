/* ============================================================
   Views. Each renderer returns DOM built with App.ui.el and reads
   only what the contract (API.md) delivers. Under neutral visibility
   the server never sends other participants' names/required status,
   so these views simply render whatever they are given.
   ============================================================ */
(function () {
  "use strict";
  var App = window.App = window.App || {};
  var U = App.ui;
  var el = U.el;

  /* ---------- time helpers (self-contained; work without core) ---------- */
  function tzOffset(ms, tz) {
    var dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var p = {}; dtf.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
  }
  // A wall-clock date (YYYY-MM-DD, optionally end-of-day) interpreted in `tz` -> UTC ms.
  function wallToUtc(dateStr, tz, endOfDay) {
    var parts = dateStr.split("-");
    var h = endOfDay ? 23 : 0, mi = endOfDay ? 59 : 0;
    var guess = Date.UTC(+parts[0], +parts[1] - 1, +parts[2], h, mi, 0);
    return guess - tzOffset(guess, tz);
  }
  // datetime-local "YYYY-MM-DDTHH:MM" interpreted in `tz` -> UTC ms.
  function localToUtc(dtLocal, tz) {
    var m = dtLocal.split("T"); if (m.length < 2) return null;
    var d = m[0].split("-"), t = m[1].split(":");
    var guess = Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1], 0);
    return guess - tzOffset(guess, tz);
  }
  // A wall-clock Y/M/D + H:M interpreted in `tz` -> UTC ms. Used to place each aligned
  // grid cell (a fixed time-of-day on a given date) onto the correct instant, DST-safe.
  function wallHmToUtc(y, mon, day, h, mi, tz) {
    var guess = Date.UTC(y, mon - 1, day, h, mi, 0);
    return guess - tzOffset(guess, tz);
  }
  // Numeric Y/M/D of an instant in `tz` (for iterating grid day columns).
  function tzYMD(ms, tz) {
    var dtf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    var p = {}; dtf.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return { y: +p.year, mon: +p.month, day: +p.day, key: p.year + "-" + p.month + "-" + p.day };
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // Every calendar date (in `tz`) from horizon start to end, inclusive. Pure calendar
  // dates stepped in UTC (DST-agnostic — we compare dates, not instants). Keys are
  // zero-padded ISO "YYYY-MM-DD" so they match core's range-constraint parsing and sort
  // lexically the same as chronologically.
  function eachHorizonDate(startMs, endMs, tz) {
    if (startMs == null || endMs == null) return [];
    var s = tzYMD(startMs, tz), e = tzYMD(endMs, tz);
    var cur = Date.UTC(s.y, s.mon - 1, s.day), last = Date.UTC(e.y, e.mon - 1, e.day);
    var out = [];
    while (cur <= last) {
      var dt = new Date(cur);
      var y = dt.getUTCFullYear(), mon = dt.getUTCMonth() + 1, day = dt.getUTCDate();
      out.push({ y: y, mon: mon, day: day, dow: dt.getUTCDay(), key: y + "-" + pad2(mon) + "-" + pad2(day) });
      cur += 86400000;
    }
    return out;
  }
  // Default response deadline: now + 48h, rounded up to the top of the hour in `tz`.
  function default48hDeadline(tz) {
    var target = Date.now() + 48 * 3600000;
    var wall = new Date(target + tzOffset(target, tz)); // wall clock carried on a UTC Date
    if (wall.getUTCMinutes() || wall.getUTCSeconds() || wall.getUTCMilliseconds()) {
      wall.setUTCMinutes(0, 0, 0); wall.setUTCHours(wall.getUTCHours() + 1);
    }
    return wallHmToUtc(wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), 0, tz);
  }
  function dateInputValue(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function bandOf(hourStr) { var h = +hourStr; return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"; }
  // Local weekday (0=Sun..6=Sat) and fractional hour of an instant in `tz`.
  function localHourInfo(ms, tz) {
    var dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
      weekday: "short", hour: "2-digit", minute: "2-digit" });
    var p = {}; dtf.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { weekday: wd[p.weekday], hourFloat: +p.hour + (+p.minute) / 60 };
  }

  /* ---------- shared chrome ---------- */
  function brandbar(visibility) {
    return el("div", { class: "brandbar" }, [
      el("span", { class: "mark" }, [el("span", { class: "dot" }), "Dynamic Scheduler"]),
      visibility ? el("span", { class: "visch" }, visibility === "full" ? "Full transparency" : "Neutral — anonymous counts") : null
    ]);
  }
  function masthead(kicker, title, subNodes) {
    return el("header", { class: "masthead" }, [
      el("div", { class: "kicker" }, kicker),
      el("h1", {}, title),
      el("p", { class: "sub" }, subNodes)
    ]);
  }
  function centerState(icon, title, lines) {
    return el("div", { class: "center-state" }, [
      el("div", { class: "big-icon" }, icon),
      el("h1", {}, title)
    ].concat((lines || []).map(function (l) { return el("p", {}, l); })));
  }

  /* ==========================================================
     INVALID / CLOSED
     ========================================================== */
  function invalid(msg) {
    U.mount([brandbar(), centerState("⊘", "This link isn’t valid",
      [msg || "The scheduling link you followed is invalid or has expired.",
       "If you were expecting a poll, ask the organizer to resend your personal link."])]);
  }

  function closed(data) {
    var poll = data.poll || {};
    var org = poll.organizerEmail;
    var body = [
      el("div", { class: "closedbanner" }, [
        el("span", { html: '<svg class="lockbig" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' }),
        poll.state === "cancelled" || poll.state === "CANCELLED"
          ? "This poll has been cancelled."
          : "This poll is already scheduled. The calendar invite is on its way."
      ]),
      el("h2", { style: "font-family:var(--font-serif);font-size:19px;margin:6px 0 3px;" }, "Nothing to do here."),
      el("p", { class: "csub" }, "Voting is closed, so this page can’t change the meeting.")
    ];
    if (org) body.push(el("div", { class: "contactcard" }, ["Need to raise something? Email the organizer directly: ", el("span", { class: "addr" }, org)]));
    U.mount([brandbar(poll.visibility), el("div", { class: "card" }, el("div", { class: "cbody" }, body))]);
  }

  /* ==========================================================
     SETUP WIZARD
     ctx = { setupToken, context }
     ========================================================== */
  function setup(ctx) {
    var c = ctx.context;
    var now = Date.now();
    var tz0 = c.tz || U.viewerTz();
    var state = {
      title: "",
      durationMins: 60,
      tz: tz0,
      horizonStartUtc: now,
      horizonEndUtc: now + 21 * 86400000,
      workingHours: {
        startHour: (c.defaultWorkingHours && c.defaultWorkingHours.startHour) || 9,
        endHour: (c.defaultWorkingHours && c.defaultWorkingHours.endHour) || 17,
        days: (c.defaultWorkingHours && c.defaultWorkingHours.days) || [1, 2, 3, 4, 5]
      },
      minAttendees: 3,
      maxAbsences: 2,
      pivotDelayHours: 4,
      round1DeadlineUtc: default48hDeadline(tz0), // default: 48h out, top of the hour
      visibility: "neutral",
      invitees: [{ name: "", email: "", required: false }],
      slotStartsUtc: [],
      freeWindows: c.freeWindows || [],
      pasteOpen: false,
      pasteText: "",
      focusLast: false
    };
    var errFields = {};
    // Persistent server-error messages (error.fields is an ARRAY of human-readable
    // strings — see API.md). Held in closure state so they survive rerender(): the
    // form is rebuilt on every keystroke/interaction, so a banner appended to a
    // detached node would silently vanish. build() reads this and renders it inline.
    var submitErrors = [];
    // Set once createPoll succeeds ({ pollId, dashboardToken }); flips the whole
    // view to a non-editable success state so double-submit is impossible.
    var created = null;

    function poll() {
      return {
        title: state.title, durationMins: state.durationMins, tz: state.tz,
        horizonStartUtc: state.horizonStartUtc, horizonEndUtc: state.horizonEndUtc,
        workingHours: state.workingHours,
        minAttendees: state.minAttendees, maxAbsences: state.maxAbsences,
        pivotDelayHours: state.pivotDelayHours,
        round1DeadlineUtc: state.round1DeadlineUtc, visibility: state.visibility,
        invitees: state.invitees, slotStartsUtc: state.slotStartsUtc,
        linkBase: App.api.linkBase()
      };
    }

    /* candidate starts for the picker — reuse core when present */
    function candidates() {
      var p = { durationMins: state.durationMins, horizonStartUtc: state.horizonStartUtc,
        horizonEndUtc: state.horizonEndUtc, workingHours: state.workingHours, tz: state.tz };
      if (window.Sched && Sched.universe && Sched.universe.candidateStarts) {
        return Sched.universe.candidateStarts(p, state.freeWindows);
      }
      // fallback (core absent): 30-min aligned starts, clipped to horizon AND the
      // current working hours ∩ working days — the same band the core helper clips to,
      // so changing day start/end or working days re-derives boundary slots here too.
      var dur = state.durationMins * 60000, align = 30 * 60000, out = [];
      var wh = state.workingHours;
      (state.freeWindows || []).forEach(function (w) {
        var first = Math.ceil(w.startUtc / align) * align;
        for (var s = first; s + dur <= w.endUtc; s += align) {
          if (s < state.horizonStartUtc || s + dur > state.horizonEndUtc) continue;
          var a = localHourInfo(s, state.tz), b = localHourInfo(s + dur, state.tz);
          if (wh.days.indexOf(a.weekday) === -1) continue;              // start on a working day
          if (a.hourFloat < wh.startHour || a.hourFloat >= wh.endHour) continue; // start in hours
          if (b.hourFloat > wh.endHour && b.hourFloat !== 0) continue;  // end within day (0 = midnight rollover)
          out.push(s);
        }
      });
      return out.sort(function (a, b) { return a - b; });
    }

    var root = el("div", {});
    function rerender() { U.clear(root); root.appendChild(build()); }

    function field(labelText, controlNode, hint, key) {
      var f = el("div", { class: "field" + (errFields[key] ? " invalid" : "") }, [
        el("label", {}, labelText), controlNode,
        hint ? el("p", { class: "hint" }, hint) : null,
        el("p", { class: "err" }, errFields[key] || "")
      ]);
      return f;
    }

    function slotPicker() {
      var starts = candidates();
      // Drop any already-picked slot that no longer qualifies after a change to
      // working hours / working days / horizon / duration, so the server can never
      // be sent a slot it would reject as "outside the horizon".
      var validSet = {}; starts.forEach(function (s) { validSet[s] = true; });
      var beforePick = state.slotStartsUtc.length;
      state.slotStartsUtc = state.slotStartsUtc.filter(function (s) { return validSet[s]; });
      if (state.slotStartsUtc.length !== beforePick) U.toast("Removed picked slots now outside your hours/horizon");
      // Aligned time grid: every day column shows the SAME fixed set of time rows
      // (every 30-min-aligned start across the working-hours band that fits the
      // duration), so rows line up across days. A cell whose exact instant is a free
      // candidate is pickable; otherwise it's a muted "busy/unavailable" placeholder
      // that still holds its row, keeping columns aligned even when a day has a
      // midday gap.
      var freeSet = validSet; // UTC-ms keyed map of pickable candidate starts

      // Ordered unique day columns, derived from candidate days (all within horizon /
      // working days). Each carries its numeric Y/M/D so cell instants are DST-safe.
      var dayOrder = [], daySeen = {};
      starts.forEach(function (s) {
        var d = tzYMD(s, state.tz);
        if (!daySeen[d.key]) { daySeen[d.key] = true; d.rep = s; dayOrder.push(d); }
      });

      // Fixed time-of-day rows: from day start, every 30 min, while the meeting fits.
      var wh = state.workingHours;
      var durH = state.durationMins / 60;
      var rows = [];
      for (var th = wh.startHour; th + durH <= wh.endHour + 1e-9; th += 0.5) {
        var rh = Math.floor(th + 1e-9), rmi = Math.round((th - rh) * 60);
        rows.push({ h: rh, mi: rmi, label: pad2(rh) + ":" + pad2(rmi) });
      }

      var grid;
      if (!dayOrder.length || !rows.length) {
        grid = el("div", { class: "daygrid empty" }, "No free slots in this window. Widen the horizon or working hours, or reload availability.");
      } else {
        grid = el("div", { class: "daygrid" }, dayOrder.slice(0, 21).map(function (d) {
          var p = U.parts(d.rep, state.tz);
          return el("div", { class: "daycol" }, [
            el("div", { class: "dhd" }, [p.weekday, el("b", {}, p.day + " " + p.month)]),
            el("div", { class: "chipcol" }, rows.map(function (row) {
              var cellUtc = wallHmToUtc(d.y, d.mon, d.day, row.h, row.mi, state.tz);
              if (!freeSet[cellUtc]) {
                // Muted placeholder — organizer busy or outside a free window. Holds the row.
                return el("div", { class: "timechip busy", "aria-disabled": "true",
                  title: "Organizer busy or unavailable" }, row.label);
              }
              var on = state.slotStartsUtc.indexOf(cellUtc) !== -1;
              var chip = el("button", { type: "button", class: "timechip" + (on ? " on" : ""),
                "aria-pressed": on ? "true" : "false" }, row.label);
              chip.addEventListener("click", function () {
                var i = state.slotStartsUtc.indexOf(cellUtc);
                if (i !== -1) state.slotStartsUtc.splice(i, 1);
                else { if (state.slotStartsUtc.length >= 8) { U.toast("Pick at most 8 slots"); return; } state.slotStartsUtc.push(cellUtc); }
                state.slotStartsUtc.sort(function (a, b) { return a - b; });
                rerender();
              });
              return chip;
            }))
          ]);
        }));
      }

      var n = state.slotStartsUtc.length;
      // Recommend 3–5; nudge (not block) at 2 or 6–8. No hard cap below 8.
      var recommended = n >= 3 && n <= 5;
      var nudge = n === 2 || (n >= 6 && n <= 8);
      var count = el("span", { class: "picker-count" + (recommended ? " ok" : nudge ? " warn" : "") },
        [n + " picked",
         recommended ? el("span", { class: "picker-cue ok" }, "✓ recommended")
                     : nudge ? el("span", { class: "picker-cue hint" }, "3–5 works best") : null]);
      var picked = el("div", { class: "picked-list" }, state.slotStartsUtc.map(function (s) {
        return el("div", { class: "picked-item" }, [
          el("span", { class: "pi-when" }, [
            el("span", { class: "pi-d" }, U.fmtDay(s, state.tz) + " "),
            el("span", { class: "pi-h" }, U.fmtRange(s, s + state.durationMins * 60000, state.tz))
          ]),
          el("button", { type: "button", class: "pi-remove", "aria-label": "remove",
            onclick: function () { state.slotStartsUtc.splice(state.slotStartsUtc.indexOf(s), 1); rerender(); } }, "✕")
        ]);
      }));

      // diversity warning (all same day OR all same band)
      var warn = "";
      if (n >= 2) {
        var days = state.slotStartsUtc.map(function (s) { return U.fmtDay(s, state.tz); });
        var bands = state.slotStartsUtc.map(function (s) { return bandOf(U.parts(s, state.tz).hour); });
        if (days.every(function (d) { return d === days[0]; })) warn = "All slots are on the same day — spreading across days helps more people.";
        else if (bands.every(function (b) { return b === bands[0]; })) warn = "All slots are in the same part of the day — mixing times widens who can attend.";
      }

      return el("div", {}, [
        el("p", { class: "section-label" }, "Pick your slots (3–5 recommended)"),
        el("p", { class: "hint", style: "margin:0 0 10px;" }, "Bright cells are free in your calendar; muted ones are busy. Scroll sideways for more days."),
        el("div", { class: "picker-toolbar" }, [count,
          el("button", { type: "button", class: "btn-ghost", style: "padding:5px 11px;font-size:12.5px;",
            onclick: reloadAvailability }, "Reload availability")]),
        grid,
        n ? picked : null,
        el("div", { class: "warnbox" + (warn ? "" : " hidden") }, [el("span", { class: "wicon" }, "!"), warn || ""]),
        errFields.slotStartsUtc ? el("p", { class: "err", style: "display:block;" }, errFields.slotStartsUtc) : null
      ]);
    }

    async function reloadAvailability() {
      try {
        var fresh = await App.api.getSetupContext(ctx.setupToken,
          { horizonStartUtc: state.horizonStartUtc, horizonEndUtc: state.horizonEndUtc });
        state.freeWindows = fresh.freeWindows || [];
        U.toast("Availability reloaded");
      } catch (e) { U.toast(e.message); }
      rerender();
    }

    // Count invitees with a plausible email — the organizer is always +1 person.
    function validInviteeCount() {
      return state.invitees.filter(function (i) { return /.+@.+/.test((i.email || "").trim()); }).length;
    }

    function peopleCounter() {
      var invN = validInviteeCount();
      var total = 1 + invN; // organizer counts as one
      var okRange = total >= 3 && total <= 10;
      return el("div", { class: "people-count" + (okRange ? " ok" : " warn") }, [
        el("span", { class: "pc-badge" }, "You + " + invN + " = " + total),
        el("span", { class: "pc-text" }, okRange
          ? "3–10 people — ready to go."
          : (total < 3 ? "Needs 3–10 people total (you included) — add " + (3 - total) + " more."
                       : "At most 10 people — remove " + (total - 10) + "."))
      ]);
    }

    // Extract every address from arbitrary pasted text, dedupe case-insensitively,
    // skip ones already present, and append rows (name = local-part).
    function addPastedEmails(text) {
      var found = (text || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
      var have = {};
      state.invitees.forEach(function (i) { if (i.email) have[i.email.trim().toLowerCase()] = true; });
      var added = 0;
      found.forEach(function (raw) {
        var email = raw.trim(), key = email.toLowerCase();
        if (have[key]) return;
        have[key] = true;
        var local = email.split("@")[0].replace(/[._+-]+/g, " ").trim();
        state.invitees.push({ name: local, email: email, required: false });
        added++;
      });
      // Drop a single leading empty placeholder row if we just added real people.
      if (added && state.invitees.length && !state.invitees[0].name && !state.invitees[0].email) state.invitees.shift();
      state.pasteText = "";
      state.pasteOpen = false;
      rerender();
      U.toast(added ? "Added " + added + " invitee" + (added === 1 ? "" : "s") : "No new email addresses found");
    }

    function inviteeRows() {
      var lastIdx = state.invitees.length - 1;
      var rows = el("div", { class: "invitee-rows" }, state.invitees.map(function (inv, i) {
        var emailInput = el("input", { type: "email", value: inv.email, placeholder: "email@example.com", "aria-label": "Invitee email",
          oninput: function (e) { inv.email = e.target.value; },
          onkeydown: function (e) {
            if (e.key === "Enter" && i === state.invitees.length - 1) {
              e.preventDefault();
              state.invitees.push({ name: "", email: "", required: false });
              state.focusLast = true; rerender();
            }
          } });
        return el("div", { class: "inv-row" }, [
          el("input", { type: "text", value: inv.name, placeholder: "Name", "aria-label": "Invitee name",
            oninput: function (e) { inv.name = e.target.value; } }),
          emailInput,
          el("label", { class: "inv-req" }, [
            el("input", { type: "checkbox", checked: inv.required ? true : undefined,
              onchange: function (e) { inv.required = e.target.checked; } }), "Required"]),
          el("button", { type: "button", class: "inv-del", "aria-label": "remove invitee",
            onclick: function () { state.invitees.splice(i, 1); if (!state.invitees.length) state.invitees.push({ name: "", email: "", required: false }); rerender(); } }, "✕")
        ]);
      }));

      var pasteBox = null;
      if (state.pasteOpen) {
        var ta = el("textarea", { class: "paste-ta", rows: "5",
          placeholder: "Paste anything with email addresses — we’ll pull them out.",
          oninput: function (e) { state.pasteText = e.target.value; } });
        ta.value = state.pasteText || "";
        pasteBox = el("div", { class: "paste-box" }, [
          ta,
          el("div", { class: "paste-actions" }, [
            el("button", { type: "button", class: "btn-primary", style: "padding:8px 14px;font-size:13px;",
              onclick: function () { addPastedEmails(ta.value); } }, "Add addresses"),
            el("button", { type: "button", class: "btn-ghost", style: "padding:8px 14px;font-size:13px;",
              onclick: function () { state.pasteOpen = false; state.pasteText = ""; rerender(); } }, "Cancel")
          ])
        ]);
      }

      var node = el("div", {}, [
        el("p", { class: "section-label" }, "Invitees"),
        el("p", { class: "hint", style: "margin:0 0 10px;" }, "You’re included automatically. Required flags stay private."),
        peopleCounter(),
        rows,
        el("div", { class: "invitee-btns" }, [
          el("button", { type: "button", class: "btn-ghost addrow",
            onclick: function () { state.invitees.push({ name: "", email: "", required: false }); rerender(); } }, "+ Add invitee"),
          el("button", { type: "button", class: "btn-ghost addrow",
            onclick: function () { state.pasteOpen = !state.pasteOpen; rerender(); } }, state.pasteOpen ? "Close paste" : "Paste emails")
        ]),
        pasteBox,
        errFields.invitees ? el("p", { class: "err", style: "display:block;" }, errFields.invitees) : null
      ]);

      // Focus the freshly-added last email input after an Enter-triggered rerender.
      if (state.focusLast) {
        state.focusLast = false;
        var inputs = rows.querySelectorAll('input[type="email"]');
        var target = inputs[inputs.length - 1];
        if (target) setTimeout(function () { target.focus(); }, 0);
      }
      return node;
    }

    function contractPreview() {
      var slots = state.slotStartsUtc.map(function (s) { return U.fmtFull(s, s + state.durationMins * 60000, state.tz); });
      var reqNames = state.invitees.filter(function (i) { return i.required && i.name; }).map(function (i) { return i.name; });
      var dl = state.round1DeadlineUtc ? U.fmtDeadline(state.round1DeadlineUtc, state.tz) : "the deadline";
      var pred = el("div", { class: "predicate", html:
        '<span class="kw">every</span> required attendee: Works or If-needed<br>' +
        '<span class="kw">and</span> attending ≥ ' + state.minAttendees + '<br>' +
        '<span class="kw">and</span> absences ≤ ' + state.maxAbsences });
      var contractText = "If none of these reach " + state.minAttendees + " people" +
        (reqNames.length ? " with " + reqNames.join(" and ") + " on board" : "") +
        ", the tool proposes up to 3 alternatives. Decision by " + dl + ".";
      return el("div", {}, [
        el("p", { class: "section-label" }, "The success rule"),
        pred,
        slots.length ? el("p", { class: "hint", style: "margin:8px 0 0;" }, "Proposed: " + slots.join(" · ")) : null,
        el("div", { class: "contract" }, contractText)
      ]);
    }

    function dashLink(token) {
      var b = App.api.linkBase();
      return b + (b.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
    }

    function successView() {
      var link = dashLink(created.dashboardToken || "");
      return el("div", {}, [
        brandbar(),
        el("div", { class: "card" }, el("div", { class: "cbody setup-success" }, [
          el("div", { class: "success-icon" }, "✓"),
          el("h2", {}, "Poll created — invitations sent"),
          el("p", { class: "csub" }, "Invitees are getting their personal links by email. Keep this dashboard link to follow responses."),
          created.dashboardToken
            ? el("a", { class: "btn-primary dash-link", href: link }, "Open organizer dashboard →")
            : null,
          created.dashboardToken
            ? el("p", { class: "hint dash-url" }, link)
            : null
        ]))
      ]);
    }

    function submitErrorBanner() {
      if (!submitErrors.length) return null;
      return el("div", { class: "card" }, el("div", { class: "cbody" }, [
        el("div", { class: "banner-info banner-err err-list-banner" }, [
          el("strong", {}, "The scheduler couldn’t create this poll:"),
          el("ul", { class: "errlist" }, submitErrors.map(function (m) { return el("li", {}, m); }))
        ])
      ]));
    }

    function build() {
      if (created) return successView();
      var wrap = el("div", {});
      wrap.appendChild(brandbar());
      wrap.appendChild(masthead("New poll", "Create a scheduling poll",
        [el("span", {}, "Signed in as " + (c.organizerName || c.organizerEmail || "organizer") + ". "),
         el("span", { class: "tzline" }, "Timezone " + state.tz)]));
      var topErr = submitErrorBanner();
      if (topErr) wrap.appendChild(topErr);

      // Basics
      var durSel = el("select", { onchange: function (e) { state.durationMins = +e.target.value; rerender(); } },
        [30, 45, 60, 90, 120].map(function (d) { return el("option", { value: d, selected: d === state.durationMins ? true : undefined }, d + " min"); }));
      var tzSel = U.timezoneSelect(state.tz, function (z) { state.tz = z; rerender(); });

      var basics = el("div", { class: "card" }, el("div", { class: "cbody" }, [
        el("h2", {}, "The meeting"),
        field("Title", el("input", { type: "text", value: state.title, placeholder: "e.g. Q3 Research Sync",
          oninput: function (e) { state.title = e.target.value; } }), null, "title"),
        el("div", { class: "row2" }, [
          field("Duration", durSel, null, "durationMins"),
          field("Timezone", tzSel.node, "Invitees also see times in their own timezone.", "tz")
        ])
      ]));
      wrap.appendChild(basics);

      // Horizon + working hours
      var hoursOptions = function (sel) { var a = []; for (var h = 6; h <= 22; h++) a.push(el("option", { value: h, selected: h === sel ? true : undefined }, (h < 10 ? "0" : "") + h + ":00")); return a; };
      var horizon = el("div", { class: "card" }, el("div", { class: "cbody" }, [
        el("h2", {}, "When to look"),
        el("div", { class: "row2" }, [
          field("First day", el("input", { type: "date", value: dateInputValue(state.horizonStartUtc),
            onchange: function (e) { state.horizonStartUtc = wallToUtc(e.target.value, state.tz, false); rerender(); } }), null, "horizonStartUtc"),
          field("Last day", el("input", { type: "date", value: dateInputValue(state.horizonEndUtc),
            onchange: function (e) { state.horizonEndUtc = wallToUtc(e.target.value, state.tz, true); rerender(); } }), null, "horizonEndUtc")
        ]),
        field("Working days", el("div", { class: "weekdays" }, U.DOW.map(function (d, i) {
          return el("label", {}, [el("input", { type: "checkbox", checked: state.workingHours.days.indexOf(i) !== -1 ? true : undefined,
            onchange: function (e) {
              var days = state.workingHours.days;
              if (e.target.checked) { if (days.indexOf(i) === -1) days.push(i); } else { var j = days.indexOf(i); if (j !== -1) days.splice(j, 1); }
              days.sort(); rerender();
            } }), d]);
        })), null, "workingHours"),
        el("div", { class: "row2" }, [
          field("Day starts", el("select", { onchange: function (e) { state.workingHours.startHour = +e.target.value; rerender(); } }, hoursOptions(state.workingHours.startHour))),
          field("Day ends", el("select", { onchange: function (e) { state.workingHours.endHour = +e.target.value; rerender(); } }, hoursOptions(state.workingHours.endHour)))
        ])
      ]));
      wrap.appendChild(horizon);

      // Slot picker
      wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, slotPicker())));

      // Success rule
      var rule = el("div", { class: "card" }, el("div", { class: "cbody" }, [
        el("h2", {}, "Who needs to be there"),
        el("div", { class: "row3" }, [
          field("Min attendees", U.stepper(state.minAttendees, 1, 50, function (v) { state.minAttendees = v; refreshContract(); }), "Minimum people to hold the meeting."),
          field("Max absences", U.stepper(state.maxAbsences, 0, 50, function (v) { state.maxAbsences = v; refreshContract(); }), "How many responders may be left out."),
          field("Pivot delay (h)", U.stepper(state.pivotDelayHours, 0, 48, function (v) { state.pivotDelayHours = v; }), "Working hours before a rescue slate auto-launches.")
        ]),
        field("Response deadline", el("input", { type: "datetime-local",
          value: state.round1DeadlineUtc ? new Date(state.round1DeadlineUtc + tzOffset(state.round1DeadlineUtc, state.tz)).toISOString().slice(0, 16) : "",
          onchange: function (e) { state.round1DeadlineUtc = e.target.value ? localToUtc(e.target.value, state.tz) : null; refreshContract(); } }),
          "Interpreted in the meeting timezone (" + U.tzAbbrev(state.tz) + ").", "round1DeadlineUtc"),
        el("div", { class: "field" }, el("div", { class: "toggle-row" }, [
          el("span", {}, [el("span", { class: "field-label" }, "Full transparency"),
            el("span", { class: "hint" }, "Off: invitees see anonymous counts, never names.")]),
          el("label", { class: "switch" }, [
            el("input", { type: "checkbox", "aria-label": "Full transparency",
              onchange: function (e) { state.visibility = e.target.checked ? "full" : "neutral"; } }),
            el("span", { class: "track" }), el("span", { class: "knob" })])
        ]))
      ]));
      wrap.appendChild(rule);

      // Invitees
      wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, inviteeRows())));

      // Contract preview
      var contractCard = el("div", { class: "card" }, el("div", { class: "cbody" }, contractPreview()));
      wrap.appendChild(contractCard);
      function refreshContract() { U.clear(contractCard.firstChild); contractCard.firstChild.appendChild(contractPreview()); }

      // Submit
      var submitBtn = el("button", { type: "button", class: "btn-primary" }, "Create poll & send invites");
      submitBtn.addEventListener("click", function () { doSubmit(submitBtn); });
      wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, [
        submitErrors.length ? el("div", { class: "banner-info banner-err err-list-banner", style: "margin-bottom:14px;" }, [
          el("strong", {}, "Please fix the following, then create again:"),
          el("ul", { class: "errlist" }, submitErrors.map(function (m) { return el("li", {}, m); }))
        ]) : null,
        el("div", { class: "savebar" }, [submitBtn,
          el("span", { class: "savenote" }, "Invites are emailed from your Gmail immediately.")])
      ])));
      return wrap;
    }

    async function doSubmit(btn) {
      errFields = {};
      submitErrors = [];
      var localErr = validate();
      if (Object.keys(localErr).length) { errFields = localErr; rerender(); U.toast("Please fix the highlighted fields"); return; }
      btn.disabled = true; btn.textContent = "Creating…";
      try {
        var res = await App.api.createPoll(ctx.setupToken, poll());
        created = res || {};
        rerender(); // replaces the whole editable form with the success state — no button to re-click
      } catch (e) {
        // error.fields is an ARRAY of human-readable strings (API.md). Hold them in
        // closure state and rerender: the banner is rebuilt INSIDE build() from
        // submitErrors, so it survives the DOM replacement instead of attaching to a
        // detached node (the old silent-revert bug).
        submitErrors = (e.fields && e.fields.length) ? e.fields.slice() : [e.message || "Something went wrong."];
        rerender();
        U.toast("Couldn’t create the poll — see the errors above");
      }
    }

    function validate() {
      var e = {};
      if (!state.title.trim()) e.title = "Give the meeting a title.";
      if (state.slotStartsUtc.length < 2 || state.slotStartsUtc.length > 8) e.slotStartsUtc = "Pick between 2 and 8 slots (3–5 recommended).";
      if (!state.round1DeadlineUtc) e.round1DeadlineUtc = "Set a response deadline.";
      if (!state.workingHours.days.length) e.workingHours = "Select at least one working day.";
      // 3–10 people total (organizer + invitees). Organizer is always +1, so there
      // must be ≥2 invitees and ≤9 invitees. A real backend rejection users couldn't see.
      var validInv = state.invitees.filter(function (i) { return i.name.trim() && /.+@.+/.test(i.email); });
      var total = 1 + validInv.length;
      if (validInv.length < 2) e.invitees = "Add at least 2 invitees with name and email (3–10 people total, including you).";
      else if (total > 10) e.invitees = "That's " + total + " people — keep it to 10 total.";
      state.invitees = state.invitees.filter(function (i) { return i.name.trim() || i.email.trim(); });
      if (!state.invitees.length) state.invitees.push({ name: "", email: "", required: false });
      return e;
    }

    rerender();
    U.mount(root);
  }

  App.views = { invalid: invalid, closed: closed, setup: setup };
  // invitee + organizer views are attached below
  App.views.invitee = inviteeView;
  App.views.dashboard = dashboardView;
  App.views.pivot = pivotView;
  App.views.hold = holdView;
  App.views.escalate = escalateView;

  /* ==========================================================
     INVITEE PAGE
     ctx = { token, data, reload }
     ========================================================== */
  function inviteeView(ctx) {
    var data = ctx.data, poll = data.poll, you = data.you || {};
    // local, revisable working state seeded from prefills
    var votes = {}; // slotId -> answer
    function seedVotes() {
      votes = {};
      (data.slots || []).forEach(function (s) { if (s.yourVote) votes[s.slotId] = s.yourVote; });
      (data.bench || []).forEach(function (s) { if (s.yourVote) votes[s.slotId] = s.yourVote; });
      Object.keys(you.answersBySlotId || {}).forEach(function (k) { votes[k] = you.answersBySlotId[k]; });
    }
    seedVotes();
    var vetoes = {}; // DERIVED constraint map (key -> constraint); rebuilt by syncVetoes()
    var dowVeto = {}; // source of truth: weekday number (0-6) -> true = "never this day"
    var painted = {}; // source of truth: "YYYY-MM-DD" -> true = an absence day
    var vetoOpen = false; // whether the avoid-rules strip is expanded (survives rerender)

    // Contiguous painted-date runs → one inclusive range each. Horizon dates are
    // consecutive, so index-adjacency is calendar-adjacency.
    function spanRanges() {
      var days = eachHorizonDate(poll.horizonStartUtc, poll.horizonEndUtc, poll.tz);
      var spans = [], run = null;
      days.forEach(function (d) {
        if (painted[d.key]) { if (!run) run = { start: d.key, end: d.key }; else run.end = d.key; }
        else if (run) { spans.push(run); run = null; }
      });
      if (run) spans.push(run);
      return spans;
    }
    // Rebuild the constraint set the vote is submitted with: day-of-week toggles +
    // one range per painted absence span. Shape is unchanged from the old strip; the
    // contradiction check and doSave read `vetoes` exactly as before.
    function syncVetoes() {
      var v = {};
      Object.keys(dowVeto).forEach(function (d) {
        if (dowVeto[d]) { var c = { type: "dow", value: +d }; v[JSON.stringify(c)] = c; }
      });
      spanRanges().forEach(function (sp) {
        var c = { type: "range", value: sp.start + "/" + sp.end };
        v[JSON.stringify(c)] = c;
      });
      vetoes = v;
    }
    // Saved-state so users don't accidentally resubmit an unchanged answer. After a
    // successful write the button reads "Saved ✓" and is disabled; any change re-enables it.
    var saved = false, savedAt = null;
    var els = {}; // live refs to save button/note for cheap updates without a full rerender
    var errBanner = []; // persistent server-error messages (survive rerender)

    function markDirty() {
      if (saved) { saved = false; syncSave(); }
    }
    function syncSave() {
      if (els.saveBtn) {
        els.saveBtn.disabled = saved;
        els.saveBtn.textContent = saved ? "Saved ✓" : (you.name ? "Update my answer" : "Save my answer");
      }
      if (els.saveNote) {
        if (saved) { els.saveNote.className = "saved-flag"; els.saveNote.textContent = "✓ Saved " + U.fmtTime(savedAt || Date.now(), U.viewerTz()); }
        else { els.saveNote.className = "savenote"; els.saveNote.textContent = "You can change your answer until the deadline."; }
      }
    }

    var root = el("div", {});
    function rerender() { U.clear(root); root.appendChild(build()); }

    function slateSlots() { return (data.slots || []); }
    function allSlateCant() {
      var s = slateSlots();
      return s.length && s.every(function (sl) { return votes[sl.slotId] === "cant"; });
    }

    function slotRow(slot, isBench) {
      var support = slot.support;
      var previewLine = el("p", { class: "preview-hint" });
      function refreshPreview() {
        if (!support) { previewLine.style.display = "none"; return; }
        var r = U.reachPreview(poll, support, votes[slot.slotId]);
        if (!r) { previewLine.style.display = "none"; return; }
        previewLine.style.display = "";
        previewLine.textContent = r.bookable
          ? "Reaches " + r.attending + " so far — meets the " + r.min + " needed"
          : "Reaches " + r.attending + " so far — needs " + r.min;
      }
      var whenNode = U.whenBlock(slot, poll.tz);
      if (slot.busy) whenNode.querySelector(".d").appendChild(el("span", { class: "busytag" }, "No longer available"));
      var ctrl = U.voteControl(votes[slot.slotId], function (v) {
        votes[slot.slotId] = v; refreshPreview();
        saved = false;
        if (!isBench) rerender(); // rebuilds; button reflects saved=false
        else syncSave();          // bench: no rerender (would lose bench picks), update button directly
      }, { disabled: slot.busy });
      var supportLine = support ? el("p", { class: "support" },
        support.works + " works · " + support.ifneeded + " if needed · " + support.cant + " can’t") : null;
      // contradiction: an explicit yes on a slot the person's own veto would exclude
      var contra = null;
      if (window.Sched && Sched.constraints && (votes[slot.slotId] === "works" || votes[slot.slotId] === "ifneeded")) {
        var hit = Object.keys(vetoes).some(function (k) {
          try { return Sched.constraints.vetoesSlot(vetoes[k], slot, poll.tz); } catch (e) { return false; }
        });
        if (hit) contra = el("div", { class: "contra" }, "One of your avoid-rules covers this time — your answer here wins.");
      }
      var row = el("div", { class: "slot" + (slot.busy ? " busy" : "") }, [whenNode, ctrl, supportLine, previewLine, contra]);
      refreshPreview();
      return row;
    }

    // A month "paint" calendar for absence periods. Painting maps 1:1 to range
    // constraints via spanRanges()/syncVetoes(): each contiguous painted run is one
    // { type:"range", value:"YYYY-MM-DD/YYYY-MM-DD" }. Exactly two interactions, both
    // driven by pointer events so mouse and touch behave identically: drag across days
    // to paint a span (or erase, if the drag starts on a painted day), and a plain
    // click/tap toggles one day. Keyboard (Enter/Space on a day) toggles too. A stale
    // calendar left behind by a rerender is neutralised via `dead` so trailing events
    // can't double-apply.
    function absenceCalendar() {
      var tz = poll.tz;
      var days = eachHorizonDate(poll.horizonStartUtc, poll.horizonEndUtc, tz);
      var orderedKeys = days.map(function (d) { return d.key; });
      var inHorizon = {}; days.forEach(function (d) { inHorizon[d.key] = d; });
      var workingSet = {};
      ((poll.workingDays && poll.workingDays.length) ? poll.workingDays : [1, 2, 3, 4, 5]).forEach(function (d) { workingSet[d] = true; });

      var monthNames = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      var wdNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      var dowMini = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // Mon-first

      var cellByKey = {};
      var pd = null, work = null; // active pointer-drag state + its preview set
      var dead = false;        // set on commit; old closure ignores trailing events

      function paintable(key) { return !!inHorizon[key]; }
      function keysBetween(a, b) {
        var lo = a < b ? a : b, hi = a < b ? b : a;
        return orderedKeys.filter(function (k) { return k >= lo && k <= hi; });
      }
      function countSpans(set) {
        var n = 0, run = false;
        orderedKeys.forEach(function (k) { if (set[k]) { if (!run) { n++; run = true; } } else run = false; });
        return n;
      }
      var hintEl = el("p", { class: "cal-status" });
      function updateHint(set) {
        set = set || painted;
        var n = Object.keys(set).filter(function (k) { return set[k]; }).length;
        if (n) {
          var sp = countSpans(set);
          hintEl.textContent = n + (n === 1 ? " day" : " days") + " away" + (sp > 1 ? " · " + sp + " periods" : "");
          hintEl.className = "cal-status has";
        } else {
          hintEl.textContent = "Drag across days you’re away, or tap a single day.";
          hintEl.className = "cal-status";
        }
      }
      function paintClasses(set) {
        orderedKeys.forEach(function (key, idx) {
          var cell = cellByKey[key]; if (!cell) return;
          var on = !!set[key];
          var prevOn = idx > 0 && set[orderedKeys[idx - 1]];
          var nextOn = idx < orderedKeys.length - 1 && set[orderedKeys[idx + 1]];
          cell.classList.toggle("on", on);
          cell.classList.toggle("span-l", on && !prevOn);
          cell.classList.toggle("span-r", on && !nextOn);
          cell.setAttribute("aria-pressed", on ? "true" : "false");
        });
        updateHint(set);
      }
      function commit() { if (dead) return; dead = true; syncVetoes(); saved = false; rerender(); }

      function toggle(key) {
        if (dead || !paintable(key)) return;
        if (painted[key]) delete painted[key]; else painted[key] = true;
        commit();
      }

      var monthsWrap = el("div", { class: "abscal-months" });
      function applyDrag(currentKey) {
        work = {}; Object.keys(painted).forEach(function (k) { if (painted[k]) work[k] = true; });
        keysBetween(pd.anchor, currentKey).forEach(function (k) {
          if (pd.mode === "paint") work[k] = true; else delete work[k];
        });
        paintClasses(work);
      }
      monthsWrap.addEventListener("pointerdown", function (e) {
        if (dead) return;
        var cell = e.target.closest && e.target.closest("[data-date]");
        if (!cell) return;
        var key = cell.dataset.date;
        if (!paintable(key)) return;
        e.preventDefault();
        pd = { anchor: key, mode: painted[key] ? "erase" : "paint", moved: false };
        try { monthsWrap.setPointerCapture(e.pointerId); } catch (_) {}
      });
      monthsWrap.addEventListener("pointermove", function (e) {
        if (dead || !pd) return;
        var t = document.elementFromPoint(e.clientX, e.clientY);
        var cell = t && t.closest && t.closest("[data-date]");
        if (!cell) return;
        var key = cell.dataset.date;
        if (!paintable(key)) return;
        if (key !== pd.anchor) pd.moved = true;
        applyDrag(key);
      });
      function endDrag(e) {
        if (!pd) return;
        try { monthsWrap.releasePointerCapture(e.pointerId); } catch (_) {}
        var moved = pd.moved, w = work, anchor = pd.anchor; pd = null; work = null;
        if (e.type === "pointercancel") { paintClasses(painted); return; } // discard preview
        if (moved && w) { painted = w; commit(); }
        else toggle(anchor); // a non-moved press is a tap: toggle that one day
      }
      monthsWrap.addEventListener("pointerup", endDrag);
      monthsWrap.addEventListener("pointercancel", endDrag);

      days.length && (function () {
        var months = [], seen = {};
        days.forEach(function (d) { var mk = d.y + "-" + d.mon; if (!seen[mk]) { seen[mk] = true; months.push({ y: d.y, mon: d.mon }); } });
        months.forEach(function (m) {
          var daysInMonth = new Date(Date.UTC(m.y, m.mon, 0)).getUTCDate();
          var lead = (new Date(Date.UTC(m.y, m.mon - 1, 1)).getUTCDay() + 6) % 7; // Mon-first
          var cells = [];
          for (var i = 0; i < lead; i++) cells.push(el("span", { class: "calday pad", "aria-hidden": "true" }));
          for (var dn = 1; dn <= daysInMonth; dn++) {
            var key = m.y + "-" + pad2(m.mon) + "-" + pad2(dn);
            var d = inHorizon[key];
            if (!d) { cells.push(el("span", { class: "calday out", "aria-hidden": "true" }, String(dn))); continue; }
            var working = !!workingSet[d.dow];
            var cell = el("button", {
              type: "button", "data-date": key,
              class: "calday" + (working ? "" : " nonwork"),
              "aria-pressed": painted[key] ? "true" : "false",
              "aria-label": wdNames[d.dow] + " " + d.day + " " + monthNames[m.mon - 1] + (working ? "" : " (no meetings)")
            }, String(dn));
            (function (k) {
              cell.addEventListener("click", function (ev) { if (ev.detail === 0) toggle(k); }); // keyboard (Enter/Space)
            })(key);
            cellByKey[key] = cell;
            cells.push(cell);
          }
          monthsWrap.appendChild(el("div", { class: "abscal-month" }, [
            el("div", { class: "abscal-mhd" }, monthNames[m.mon - 1] + " " + m.y),
            el("div", { class: "abscal-dow" }, dowMini.map(function (x, i) { return el("span", { class: i >= 5 ? "we" : "" }, x); })),
            el("div", { class: "abscal-grid", role: "group", "aria-label": "Days you’re away in " + monthNames[m.mon - 1] }, cells)
          ]));
        });
      })();

      var clearBtn = el("button", { type: "button", class: "cal-clear" }, "Clear all");
      clearBtn.addEventListener("click", function () {
        if (dead || !Object.keys(painted).length) return;
        painted = {}; commit();
      });

      paintClasses(painted); // reflect already-painted spans on (re)build
      var head = el("div", { class: "abscal-head" }, [hintEl, clearBtn]);
      var node = days.length
        ? el("div", { class: "abscal" }, [head, monthsWrap])
        : el("p", { class: "vhint" }, "No dates available to mark.");
      return { node: node };
    }

    function vetoStrip(forceOpen) {
      if (forceOpen) vetoOpen = true;
      var open = forceOpen || vetoOpen;
      var workingDays = ((poll.workingDays && poll.workingDays.length) ? poll.workingDays.slice() : [1, 2, 3, 4, 5])
        .sort(function (a, b) { return a - b; });
      var dowFull = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

      var dowRow = el("div", { class: "chiprow" }, workingDays.map(function (d) {
        var chip = el("button", { type: "button", class: "vchip", "aria-pressed": dowVeto[d] ? "true" : "false" }, "No " + dowFull[d]);
        chip.addEventListener("click", function () {
          if (dowVeto[d]) delete dowVeto[d]; else dowVeto[d] = true;
          syncVetoes(); saved = false; rerender();
        });
        return chip;
      }));

      var body = el("div", { class: "vetobody" }, [
        el("p", { class: "vseclbl" }, "Days that never work"),
        dowRow,
        el("p", { class: "vseclbl", style: "margin-top:16px;" }, "Dates you’re away"),
        absenceCalendar().node,
        el("p", { class: "vhint" }, "Private to you — only used if another time must be found.")
      ]);
      var strip = el("div", { class: "vetostrip" + (open ? " open" : "") });
      var hd = el("button", { type: "button", class: "vetohd", "aria-expanded": open ? "true" : "false" }, [
        el("span", { class: "caret" }, "›"),
        el("span", {}, "Days that never work, or dates you’re away?"),
        el("span", { class: "tagwhy" + (forceOpen ? " opened" : "") }, forceOpen ? "Opened for you" : "Optional")
      ]);
      hd.addEventListener("click", function () { var o = strip.classList.toggle("open"); vetoOpen = o; hd.setAttribute("aria-expanded", o ? "true" : "false"); });
      strip.appendChild(hd); strip.appendChild(body);
      return strip;
    }

    function benchPicker() {
      var opts = data.benchOptions || [];
      var picks = {};
      var countLine = el("p", { class: "benchcount" });
      function refresh() {
        var n = Object.keys(picks).length;
        countLine.textContent = n + " of 3 picked — they count as your “Works” in a next round.";
      }
      var box = el("div", { class: "bench show" }, [
        el("h3", {}, "None of those work? These times are still free for the organizer."),
        el("p", { class: "bsub" }, "Pick up to 3 that could work for you."),
        el("div", {}, opts.map(function (o, i) {
          var pb = el("button", { type: "button", class: "pickbox", role: "checkbox", "aria-checked": "false",
            "aria-label": "Pick " + U.fmtFull(o.startUtc, o.endUtc, poll.tz) }, "");
          pb.addEventListener("click", function () {
            var on = pb.getAttribute("aria-checked") === "true";
            if (!on && Object.keys(picks).length >= 3) { U.toast("Pick at most 3"); return; }
            if (on) { delete picks[i]; pb.setAttribute("aria-checked", "false"); pb.textContent = ""; }
            else { picks[i] = o; pb.setAttribute("aria-checked", "true"); pb.textContent = "✓"; }
            markDirty();
            refresh();
          });
          return el("div", { class: "benchpick" }, [pb,
            el("span", { class: "bd" }, [el("span", { class: "bday" }, U.fmtDay(o.startUtc, poll.tz) + " "),
              el("span", { class: "bh" }, U.fmtRange(o.startUtc, o.endUtc, poll.tz))])]);
        })),
        countLine
      ]);
      refresh();
      box._getPicks = function () { return Object.keys(picks).map(function (k) { return { startUtc: picks[k].startUtc, endUtc: picks[k].endUtc }; }); };
      return box;
    }

    function build() {
      var wrap = el("div", {});
      wrap.appendChild(brandbar(poll.visibility));
      wrap.appendChild(masthead(poll.roundLabel || "Your answer",
        "Which of these work" + (you.name ? ", " + you.name : "") + "?",
        [el("span", {}, poll.title + " · " + poll.durationMins + " min. “If needed” = possible but inconvenient. "),
         poll.deadlineUtc ? el("span", { class: "tzline" }, "Respond by " + U.fmtDeadline(poll.deadlineUtc, poll.tz) + " (" + U.tzAbbrev(poll.tz) + ")") : null]));

      var cardBody = [];
      if (errBanner.length) {
        cardBody.push(el("div", { class: "banner-info banner-err err-list-banner" }, [
          el("strong", {}, "Your answer wasn’t saved:"),
          el("ul", { class: "errlist" }, errBanner.map(function (m) { return el("li", {}, m); }))
        ]));
      }
      slateSlots().forEach(function (s) { cardBody.push(slotRow(s, false)); });

      var isAllCant = allSlateCant();
      cardBody.push(vetoStrip(isAllCant));

      var picker = null;
      if (isAllCant && (data.benchOptions || []).length) { picker = benchPicker(); cardBody.push(picker); }

      // existing bench slots to score (later visitors)
      if ((data.bench || []).length) {
        cardBody.push(el("div", { class: "bench show", style: "margin-top:14px;" }, [
          el("h3", {}, "Other suggested times — do these work?"),
          el("p", { class: "bsub" }, "Answering these too may save you another step.")
        ].concat(data.bench.map(function (s) { return slotRow(s, true); }))));
      }

      var saveBtn = el("button", { type: "button", class: "btn-primary",
        disabled: saved ? true : undefined }, saved ? "Saved ✓" : (you.name ? "Update my answer" : "Save my answer"));
      var saveNote = saved
        ? el("span", { class: "saved-flag" }, "✓ Saved " + U.fmtTime(savedAt || Date.now(), U.viewerTz()))
        : el("span", { class: "savenote" }, "You can change your answer until the deadline.");
      els.saveBtn = saveBtn; els.saveNote = saveNote;
      saveBtn.addEventListener("click", function () { doSave(saveBtn, saveNote, picker); });
      cardBody.push(el("div", { class: "savebar" }, [saveBtn, saveNote]));

      wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, cardBody)));
      wrap.appendChild(el("p", { class: "footer-note" }, "Your personal link · nothing is recorded until you save"));
      return wrap;
    }

    async function doSave(btn, note, picker) {
      btn.disabled = true; btn.textContent = "Saving…";
      var constraints = Object.keys(vetoes).map(function (k) { return vetoes[k]; });
      try {
        // Every write returns a fresh getState-shaped payload; re-render from that
        // rather than a second round-trip, so the saved state reflects authority.
        var fresh = await App.api.submitVotes(ctx.token, votes, constraints.length ? constraints : undefined);
        if (picker && picker._getPicks().length) {
          var afterBench = await App.api.proposeBench(ctx.token, picker._getPicks());
          if (afterBench) fresh = afterBench;
        }
        if (fresh && fresh.poll) { data = fresh; poll = data.poll; you = data.you || {}; seedVotes(); }
        errBanner = [];
        saved = true; savedAt = Date.now();
        rerender();          // rebuilds with the disabled "Saved ✓" button
        U.toast("Your answer is saved");
      } catch (e) {
        btn.disabled = false; btn.textContent = you.name ? "Update my answer" : "Save my answer";
        // Persist the error so it survives any later rerender (not just a transient toast).
        errBanner = (e.fields && e.fields.length) ? e.fields.slice() : [e.message || "Something went wrong."];
        rerender();
        U.toast("Couldn’t save — see the message above");
      }
    }

    rerender();
    U.mount(root);
  }

  /* ==========================================================
     ORGANIZER — shared header
     ========================================================== */
  function orgHeader(poll, kicker, title, extra) {
    return [brandbar(poll.visibility), masthead(kicker, title,
      [el("span", {}, poll.title + " · " + poll.durationMins + " min · " + U.tzAbbrev(poll.tz) + ". "),
       poll.deadlineUtc ? el("span", { class: "tzline" }, "Deadline " + U.fmtDeadline(poll.deadlineUtc, poll.tz)) : null].concat(extra || []))];
  }

  function slotDiagnostics(poll, slots, diagnostics) {
    var byId = {};
    (diagnostics || []).forEach(function (d) { (byId[d.slotId] = byId[d.slotId] || []).push(d); });
    return el("div", { class: "system" }, [
      el("div", { class: "stop" }, [el("span", { class: "tab" }, "Status"), el("span", {}, "per-slot verdict — organizer view")]),
      el("div", { class: "sbody" }, (slots || []).map(function (s) {
        var reasons = (s.reasons || []).map(function (r) { return r.text; });
        (byId[s.slotId] || []).forEach(function (d) { reasons.push(d.text); });
        var status = s.status || "alive";
        return el("div", { class: "srow" }, [
          el("span", { class: "slotid" }, U.fmtDay(s.startUtc, poll.tz) + " " + U.fmtTime(s.startUtc, poll.tz)),
          el("span", { class: "reason", html: reasons.length ? reasons.join(" · ") : coverageText(s) }),
          el("span", { class: "verdict " + status }, status)
        ]);
      }))
    ]);
  }
  function coverageText(s) {
    if (!s.support) return "Awaiting responses.";
    return "<b>" + s.support.works + "</b> works · " + s.support.ifneeded + " if needed · " + s.support.cant + " can’t.";
  }

  function coverageCard(org) {
    var cov = (org.coverage || []);
    var budget = org.emailBudget;
    var kids = [
      el("p", { class: "section-label" }, "Who has responded"),
      el("div", { class: "coverage" }, cov.map(function (p) {
        return el("span", { class: "covchip " + (p.responded ? "in" : "out") }, [el("span", { class: "cdot" }), p.name]);
      }))
    ];
    if (budget) {
      var pct = budget.total ? Math.min(100, Math.round(budget.used / budget.total * 100)) : 0;
      kids.push(el("div", { class: "budget" + (budget.squeezed ? " squeezed" : ""), style: "margin-top:16px;" }, [
        el("div", { class: "blbl" }, [el("span", {}, "Email budget today"), el("span", {}, budget.used + " / " + budget.total)]),
        el("div", { class: "bbar" }, el("i", { style: "width:" + pct + "%" })),
        budget.squeezed ? el("p", { class: "bnote" }, "Budget squeezed — lowest-priority mail is being held back.") : null
      ]));
    }
    return el("div", { class: "card" }, el("div", { class: "cbody" }, kids));
  }

  /* ---------- dashboard ---------- */
  function dashboardView(ctx) {
    var data = ctx.data, poll = data.poll, org = data.organizer || {};
    var wrap = el("div", {});
    orgHeader(poll, "Organizer dashboard · " + (poll.state || "").toLowerCase(), poll.title + " — dashboard").forEach(function (n) { wrap.appendChild(n); });
    wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" },
      slotDiagnostics(poll, data.slots, org.diagnostics))));
    wrap.appendChild(coverageCard(org));

    var cancelBtn = el("button", { type: "button", class: "btn-danger" }, "Cancel poll");
    cancelBtn.addEventListener("click", async function () {
      cancelBtn.disabled = true;
      try { await App.api.cancelPoll(ctx.token); await ctx.reload(); } catch (e) { cancelBtn.disabled = false; U.toast(e.message); }
    });
    wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, [
      el("p", { class: "csub", style: "margin:0 0 12px;" }, "Runs on its own — you’re only needed at pivot, hold, or escalation."),
      el("div", { class: "primaryrow" }, [cancelBtn])
    ])));
    wrap.appendChild(el("p", { class: "footer-note" }, "Only you see names — invitee pages stay anonymous"));
    U.mount(wrap);
  }

  /* ---------- pivot / launch ---------- */
  function pivotView(ctx) {
    var data = ctx.data, poll = data.poll, org = data.organizer || {};
    var pivot = org.pivot || { proposed: [], dueUtc: null };
    var votes = {};
    pivot.proposed.forEach(function (s) { votes[s.slotId] = "works"; }); // prefilled to Works

    var wrap = el("div", {});
    orgHeader(poll, "Pivot · slate 2 of 2 — final round", "Confirm your times, then launch").forEach(function (n) { wrap.appendChild(n); });

    // why slate 1 died
    if ((org.diagnostics || []).length) {
      wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, [
        el("p", { class: "section-label" }, "Why the first times failed"),
        slotDiagnostics(poll, data.slots, org.diagnostics)
      ])));
    }

    var cardBody = [el("p", { class: "csub" }, "Prefilled to Works from your free calendar. Downgrade to “If needed”, or “Can’t” to drop a time.")];
    pivot.proposed.forEach(function (s) {
      var card = el("div", { class: "slotcard" }, [
        el("span", { class: "d" }, U.fmtFull(s.startUtc, s.endUtc, poll.tz)),
        s.reasoning ? el("span", { class: "h" }, s.reasoning) : null
      ]);
      card.appendChild(U.voteControl("works", function (v) {
        votes[s.slotId] = v;
        card.style.opacity = v === "cant" ? ".55" : "1";
      }));
      cardBody.push(card);
    });

    if (pivot.dueUtc) {
      var remaining = Math.max(0, pivot.dueUtc - Date.now());
      var hrs = Math.floor(remaining / 3600000), mins = Math.floor((remaining % 3600000) / 60000);
      cardBody.push(el("div", { class: "countdown" }, [
        el("div", { class: "lbl" }, [el("span", {}, "Auto-launches with your Works answers if untouched"),
          el("span", { class: "rem" }, hrs + "h " + mins + "m left")]),
        el("div", { class: "cdbar" }, el("i", { style: "width:" + Math.min(100, remaining / (4 * 3600000) * 100) + "%" }))
      ]));
    }

    var launchBtn = el("button", { type: "button", class: "btn-primary" }, "Vote & launch round 2");
    launchBtn.addEventListener("click", async function () {
      launchBtn.disabled = true; launchBtn.textContent = "Launching…";
      try { await App.api.organizerLaunch(ctx.token, votes); await ctx.reload(); }
      catch (e) { launchBtn.disabled = false; launchBtn.textContent = "Vote & launch round 2"; U.toast(e.message); }
    });
    cardBody.push(el("div", { class: "savebar" }, [launchBtn,
      el("span", { class: "savenote" }, "This casts your votes before any invitee is asked.")]));

    wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, cardBody)));
    wrap.appendChild(el("p", { class: "footer-note" }, "If this slate fails too, the tool escalates — there is no round 3"));
    U.mount(wrap);
  }

  /* ---------- hold approve/reject ---------- */
  function holdView(ctx) {
    var data = ctx.data, poll = data.poll, org = data.organizer || {};
    var hold = org.hold || {};
    var slot = (data.slots || []).filter(function (s) { return s.slotId === hold.slotId; })[0];
    var wrap = el("div", {});
    orgHeader(poll, "Hold · organizer approval", "Book the " + poll.title + "?").forEach(function (n) { wrap.appendChild(n); });

    var body = [];
    if (slot) body.push(el("div", { class: "slotcard top" }, [
      el("span", { class: "d" }, U.fmtFull(slot.startUtc, slot.endUtc, poll.tz)) ]));
    body.push(el("div", { class: "who-clash" }, [
      el("span", { class: "ok" }, "Confirmed: "), (hold.confirmed || []).join(", ") || "—", el("br"),
      el("span", { class: "clash" }, "May report a clash: "), (hold.mayClash || []).length ? hold.mayClash.join(", ") : "none"
    ]));
    if (hold.autoBookUtc) body.push(el("p", { class: "csub" }, "Auto-books at " + U.fmtDeadline(hold.autoBookUtc, poll.tz) + " unless you act."));

    var approve = el("button", { type: "button", class: "btn-primary" }, "Approve & book");
    approve.addEventListener("click", async function () { approve.disabled = true; approve.textContent = "Booking…";
      try { await App.api.organizerApprove(ctx.token, hold.slotId); await ctx.reload(); }
      catch (e) { approve.disabled = false; approve.textContent = "Approve & book"; U.toast(e.message); } });
    var reject = el("button", { type: "button", class: "btn-ghost" }, "Reject this slot");
    reject.addEventListener("click", async function () { reject.disabled = true;
      try { await App.api.organizerReject(ctx.token, hold.slotId); await ctx.reload(); }
      catch (e) { reject.disabled = false; U.toast(e.message); } });
    body.push(el("div", { class: "primaryrow" }, [approve, reject]));

    wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, body)));
    wrap.appendChild(el("p", { class: "footer-note" }, "Invitees hear via the calendar invite"));
    U.mount(wrap);
  }

  /* ---------- escalate ---------- */
  function escalateView(ctx) {
    var data = ctx.data, poll = data.poll, org = data.organizer || {};
    var esc = org.escalate || { diagnosis: "", levers: [] };
    var wrap = el("div", {});
    orgHeader(poll, "Escalate · rescue slate infeasible", "This needs your call").forEach(function (n) { wrap.appendChild(n); });
    wrap.appendChild(el("div", { class: "card" }, el("div", { class: "cbody" }, [
      el("div", { class: "banner-info banner-warn" }, esc.diagnosis || "No slot in the rescue slate can satisfy the success rule."),
      el("p", { class: "section-label", style: "margin-top:16px;" }, "Your options"),
      el("div", { class: "levers" }, (esc.levers || []).map(function (lv) {
        var btn = el("button", { type: "button", class: /cancel/i.test(lv.id) ? "btn-danger" : "btn-ghost" }, lv.label);
        btn.addEventListener("click", function () { runLever(lv, btn); });
        return el("div", { class: "lever" }, [el("span", { class: "llbl" }, lv.label), btn]);
      }))
    ])));
    wrap.appendChild(el("p", { class: "footer-note" }, "No automatic round 3 — every path out is an explicit organizer choice"));
    U.mount(wrap);

    async function runLever(lv, btn) {
      btn.disabled = true;
      try {
        var id = lv.id || "";
        if (/cancel/i.test(id)) await App.api.cancelPoll(ctx.token);
        else if (/extend|grace/i.test(id)) await App.api.extendGrace(ctx.token);
        else if (/book|least/i.test(id)) await App.api.organizerApprove(ctx.token);
        else if (/retry/i.test(id)) await App.api.retryBooking(ctx.token);
        else { await App.api.call(id, { token: ctx.token }); } // backend-defined lever
        await ctx.reload();
      } catch (e) { btn.disabled = false; U.toast(e.message); }
    }
  }
})();
