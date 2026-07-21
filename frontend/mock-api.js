/* ============================================================
   Mock backend — ONLY active when the URL carries ?mock=1.
   Intercepts window.fetch and returns contract-shaped JSON
   ({ ok, data } / { ok:false, error }) for each action, so the
   whole app can be driven with no live Apps Script deployment.
   Routes getState by the token value:
     token=inv      -> invitee, 3 slate slots + 1 bench + benchOptions
     token=invcant  -> invitee prefilled all-Can't (bench picker shows)
     token=org      -> organizer dashboard (ROUND1)
     token=pivot    -> organizer PIVOT_PENDING (rescue slate)
     token=hold     -> organizer HOLD (approve/reject)
     token=booked   -> terminal (closed page)
   ============================================================ */
(function () {
  "use strict";
  if (new URLSearchParams(window.location.search).get("mock") !== "1") return;

  var TZ_OFFSET_H = 1; // Europe/London BST (approx, for building sample instants)
  var DAY = 86400000, H = 3600000;
  // Anchor "today" to a Monday-ish weekday near the app's clock.
  var base = Date.UTC(2026, 6, 21, 0, 0); // Tue 21 Jul 2026

  function at(dayOffset, localHour) { return base + dayOffset * DAY + (localHour - TZ_OFFSET_H) * H; }
  function slot(id, dayOffset, localHour, kind, extra) {
    var s = at(dayOffset, localHour);
    return Object.assign({ slotId: id, startUtc: s, endUtc: s + H, kind: kind || "slate1", busy: false }, extra || {});
  }

  // Contract: the backend returns freeWindows over the FULL 06:00–22:00 all-days band;
  // the client clips to working hours ∩ working days ∩ horizon. One busy block per day
  // (12:00–14:00 lunch) keeps it realistic while leaving the client the clipping job —
  // so changing day start/end or working days actually re-derives the candidate chips.
  function freeWindows() {
    var out = [];
    for (var d = 0; d < 18; d++) {
      out.push({ startUtc: at(d, 6), endUtc: at(d, 12) });
      out.push({ startUtc: at(d, 14), endUtc: at(d, 22) });
    }
    return out;
  }

  var pollBase = {
    title: "Q3 Research Sync", tz: "Europe/London", durationMins: 60,
    visibility: "neutral", deadlineUtc: at(3, 17), roundLabel: "Round 1 · your answer",
    // Poll horizon + working days now drive the invitee avoid-rules (day-of-week toggles
    // and the absence-paint calendar). ~3 weeks (Tue 21 Jul → Sun 10 Aug 2026) spans two
    // months so the multi-month calendar has something real to paint.
    workingDays: [1, 2, 3, 4, 5],
    horizonStartUtc: base, horizonEndUtc: base + 20 * DAY
  };

  function inviteeState(allCant) {
    var slots = [
      slot("s1", 0, 14, "slate1", { support: { works: 2, ifneeded: 1, cant: 1 }, yourVote: allCant ? "cant" : "works" }),
      slot("s2", 1, 10, "slate1", { support: { works: 3, ifneeded: 0, cant: 1 }, yourVote: allCant ? "cant" : "works" }),
      slot("s3", 2, 15, "slate1", { support: { works: 1, ifneeded: 1, cant: 2 }, yourVote: allCant ? "cant" : "cant" })
    ];
    var bench = [ slot("b1", 13, 11, "bench", { support: { works: 2, ifneeded: 1, cant: 0 } }) ];
    return {
      role: "invitee",
      poll: Object.assign({ state: "ROUND1", minAttendees: 4, maxAbsences: 2 }, pollBase),
      you: { name: "Priya", answersBySlotId: {}, constraints: [] },
      slots: slots,
      bench: bench,
      benchOptions: [
        { startUtc: at(13, 11), endUtc: at(13, 12) },
        { startUtc: at(15, 14), endUtc: at(15, 15) },
        { startUtc: at(16, 10), endUtc: at(16, 11) },
        { startUtc: at(17, 15), endUtc: at(17, 16) }
      ]
    };
  }

  function organizerState() {
    return {
      role: "organizer",
      poll: Object.assign({ state: "ROUND1", minAttendees: 4, maxAbsences: 2, organizerEmail: "alex.chen@gmail.com" }, pollBase),
      you: { name: "Alex Chen", answersBySlotId: {} },
      slots: [
        slot("s1", 0, 14, "slate1", { status: "blocked", support: { works: 2, ifneeded: 1, cant: 2 },
          reasons: [{ rule: "required_cant", text: "Maya voted Can’t — required, so the slot is blocked. Also hits Jonas’s no-Tuesdays veto." }] }),
        slot("s2", 1, 10, "slate1", { status: "alive", support: { works: 3, ifneeded: 1, cant: 1 },
          reasons: [{ rule: "note", text: "Needs one more attending to reach 4." }] }),
        slot("s3", 2, 15, "slate1", { status: "doomed", support: { works: 1, ifneeded: 1, cant: 3 },
          reasons: [{ rule: "max_absences", text: "3 Can’t already exceeds the 2 absences allowed." }] })
      ],
      bench: [],
      organizer: {
        coverage: [
          { name: "Alex Chen", responded: true }, { name: "Maya Lindqvist", responded: true },
          { name: "Jonas Weber", responded: true }, { name: "Priya Sharma", responded: true },
          { name: "Tom Okafor", responded: false }, { name: "Sofia Reyes", responded: false }
        ],
        emailBudget: { used: 12, total: 100, squeezed: false },
        diagnostics: []
      }
    };
  }

  function pivotState() {
    return {
      role: "organizer",
      poll: Object.assign({ state: "PIVOT_PENDING", minAttendees: 4, maxAbsences: 2, roundLabel: "Pivot", organizerEmail: "alex.chen@gmail.com" }, pollBase),
      you: { name: "Alex Chen", answersBySlotId: {} },
      slots: [
        slot("s1", 0, 14, "slate1", { status: "blocked", reasons: [{ text: "Maya voted Can’t — required, blocked." }] }),
        slot("s2", 1, 10, "slate1", { status: "blocked", reasons: [{ text: "Maya voted Can’t — required, blocked." }] }),
        slot("s3", 2, 15, "slate1", { status: "blocked", reasons: [{ text: "Alex’s calendar now shows this hour busy." }] })
      ],
      bench: [],
      organizer: {
        coverage: [], emailBudget: { used: 14, total: 100, squeezed: false }, diagnostics: [],
        pivot: {
          dueUtc: Date.now() + 3.75 * H,
          proposed: [
            { slotId: "r1", startUtc: at(15, 14), endUtc: at(15, 15), reasoning: "Maya works · clears Jonas’s conflicts · different day" },
            { slotId: "r2", startUtc: at(13, 11), endUtc: at(13, 12), reasoning: "Maya works · clear of Jonas’s conflicts" },
            { slotId: "r3", startUtc: at(16, 10), endUtc: at(16, 11), reasoning: "Maya if needed · different time band" }
          ]
        }
      }
    };
  }

  function holdState() {
    return {
      role: "organizer",
      poll: Object.assign({ state: "HOLD", minAttendees: 4, maxAbsences: 2, roundLabel: "Hold", organizerEmail: "alex.chen@gmail.com" }, pollBase),
      you: { name: "Alex Chen", answersBySlotId: {} },
      slots: [ slot("r1", 15, 14, "slate2", { status: "bookable" }) ],
      bench: [],
      organizer: {
        coverage: [], emailBudget: { used: 18, total: 100, squeezed: false }, diagnostics: [],
        hold: { slotId: "r1", confirmed: ["Alex", "Maya", "Jonas", "Priya", "Tom"], mayClash: ["Sofia"], autoBookUtc: Date.now() + 22 * H }
      }
    };
  }

  function setupContext() {
    return {
      organizerEmail: "alex.chen@gmail.com", organizerName: "Alex Chen", tz: "Europe/London",
      defaultWorkingHours: { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] },
      freeWindows: freeWindows()
    };
  }

  function handle(req) {
    var a = req.action;
    if (a === "getSetupContext") return ok(setupContext());
    if (a === "createPoll") {
      var p = req.poll || {};
      // error.fields is an ARRAY of human-readable strings (see API.md). ?createfail=1
      // exercises a realistic multi-message rejection so the visible-error state can be tested.
      var qs = new URLSearchParams(window.location.search);
      var fields = [];
      if (qs.get("createfail") === "1") {
        fields = [
          "The response deadline must be at least 2 hours from now.",
          "Two of your slots fall in the same afternoon — spread them across the week for wider coverage.",
          "A poll needs 3–10 people total; this one has only you plus 1 invitee."
        ];
      } else if (!p.title) {
        fields = ["Give the meeting a title."];
      }
      if (fields.length) return err("rejected", "Some fields need attention.", fields);
      return ok({ pollId: "mock-poll", dashboardToken: "org" });
    }
    if (a === "getState") {
      var t = req.token;
      if (t === "org") return ok(organizerState());
      if (t === "pivot") return ok(pivotState());
      if (t === "hold") return ok(holdState());
      if (t === "booked") return ok({ role: "invitee", poll: Object.assign({ state: "BOOKED" }, pollBase), slots: [], bench: [] });
      if (t === "invcant") return ok(inviteeState(true));
      if (t === "inv" || t === "invitee") return ok(inviteeState(false));
      return err("not_found", "This scheduling link is invalid or has expired.");
    }
    // all writes echo a fresh getState-shaped payload
    if (a === "submitVotes" || a === "saveConstraints" || a === "proposeBench") return ok(inviteeState(false));
    if (a === "organizerLaunch") return ok(pivotState());
    if (a === "organizerApprove") return ok({ role: "organizer", poll: Object.assign({ state: "BOOKED" }, pollBase), slots: [], bench: [] });
    if (a === "organizerReject" || a === "extendGrace" || a === "retryBooking" || a === "demoteRequired") return ok(organizerState());
    if (a === "cancelPoll") return ok({ role: "organizer", poll: Object.assign({ state: "CANCELLED" }, pollBase), slots: [], bench: [] });
    return err("bad_request", "Unknown action: " + a);
  }
  function ok(data) { return { ok: true, data: data }; }
  function err(code, message, fields) { return { ok: false, error: { code: code, message: message, fields: fields } }; }

  var realFetch = window.fetch;
  window.fetch = function (url, opts) {
    try {
      var req = JSON.parse((opts && opts.body) || "{}");
      var payload = handle(req);
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(payload); },
        text: function () { return Promise.resolve(JSON.stringify(payload)); }
      });
    } catch (e) {
      return realFetch ? realFetch(url, opts) : Promise.reject(e);
    }
  };
  window.__mockActive = true;
})();
