/* ============================================================
   API transport — the ONLY thing the frontend knows about the backend.
   Every call is a CORS "simple request": POST, Content-Type text/plain,
   JSON in the body. Never application/json (that would trigger a preflight
   Apps Script cannot answer). Reads and writes are both POST per API.md.
   ============================================================ */
(function () {
  "use strict";

  // Configurable API base: ?api=<execUrl> wins, else this fallback constant
  // (the live Apps Script deployment this hosted frontend belongs to).
  var API_BASE = "https://script.google.com/macros/s/AKfycbwTHEhRmpl5K7nzZyRSyXqVj768QHIWMLJf0gvrMoJ8wbecbKDOD18elo3HoHc33oXK/exec";

  var App = window.App = window.App || {};

  function resolveBase() {
    var qs = new URLSearchParams(window.location.search);
    // Under the mock (?mock=1) fetch is intercepted, so any non-empty base works.
    if (qs.get("mock") === "1") return qs.get("api") || "mock://api";
    return qs.get("api") || API_BASE;
  }

  /**
   * Dispatch one action to the backend and unwrap the envelope.
   * Resolves with `data` on { ok:true }, rejects with an Error carrying
   * .code / .fields on { ok:false } or transport failure.
   */
  async function call(action, payload) {
    var base = resolveBase();
    if (!base) {
      throw apiError("server_error",
        "No API endpoint configured. Add ?api=<execUrl> to the URL, or set ?mock=1 to preview against the mock backend.");
    }
    var body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    var res;
    try {
      res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: body
      });
    } catch (e) {
      throw apiError("server_error", "Could not reach the scheduler. Check your connection and try again.");
    }
    var json;
    try {
      json = await res.json();
    } catch (e) {
      throw apiError("server_error", "The scheduler returned an unexpected response.");
    }
    if (json && json.ok) return json.data;
    var err = (json && json.error) || {};
    throw apiError(err.code || "server_error", err.message || "Something went wrong.", err.fields);
  }

  function apiError(code, message, fields) {
    var e = new Error(message);
    e.code = code;
    if (fields) e.fields = fields;
    return e;
  }

  // Thin named wrappers over the contract.
  App.api = {
    base: resolveBase,
    call: call,
    getState: function (token) { return call("getState", { token: token }); },
    getSetupContext: function (setupToken, horizon) {
      return call("getSetupContext", Object.assign({ setupToken: setupToken }, horizon || {}));
    },
    createPoll: function (setupToken, poll) { return call("createPoll", { setupToken: setupToken, poll: poll }); },
    // Base URL for invitee/organizer links the backend emails: this app's own location,
    // carrying ?api= only when the API came from the URL (a baked-in API_BASE needs none).
    linkBase: function () {
      var base = window.location.origin + window.location.pathname;
      var qs = new URLSearchParams(window.location.search);
      var api = qs.get("api");
      return api ? base + "?api=" + encodeURIComponent(api) : base;
    },
    submitVotes: function (token, votes, constraints) {
      var p = { token: token, votes: votes };
      if (constraints) p.constraints = constraints;
      return call("submitVotes", p);
    },
    saveConstraints: function (token, constraints) { return call("saveConstraints", { token: token, constraints: constraints }); },
    proposeBench: function (token, slots) { return call("proposeBench", { token: token, slots: slots }); },
    organizerLaunch: function (token, votes) { return call("organizerLaunch", { token: token, votes: votes }); },
    organizerApprove: function (token, slotId) { return call("organizerApprove", { token: token, slotId: slotId }); },
    organizerReject: function (token, slotId) { return call("organizerReject", { token: token, slotId: slotId }); },
    extendGrace: function (token) { return call("extendGrace", { token: token }); },
    demoteRequired: function (token, targetInviteeId) { return call("demoteRequired", { token: token, targetInviteeId: targetInviteeId }); },
    retryBooking: function (token) { return call("retryBooking", { token: token }); },
    cancelPoll: function (token) { return call("cancelPoll", { token: token }); }
  };
})();
