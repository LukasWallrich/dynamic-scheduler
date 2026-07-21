/* ============================================================
   Router / bootstrap. Routing is by URL param — tokens are identity,
   there is no login. Role and poll state come from getState.
     ?setup=<setupToken>  -> setup wizard
     ?token=<t>           -> invitee or organizer view (role from getState)
     (missing/invalid)    -> friendly "invalid link" page
   ============================================================ */
(function () {
  "use strict";
  var App = window.App, U = App.ui, V = App.views;

  U.applyTheme();

  var qs = new URLSearchParams(window.location.search);
  var setupToken = qs.get("setup");
  var token = qs.get("token");

  function loading() { document.getElementById("app").innerHTML = '<div class="loading">Loading…</div>'; }

  async function start() {
    if (setupToken) return startSetup();
    if (token) return startState();
    return V.invalid("No scheduling token in the link.");
  }

  async function startSetup() {
    loading();
    try {
      var context = await App.api.getSetupContext(setupToken);
      V.setup({ setupToken: setupToken, context: context });
    } catch (e) {
      if (e.code === "unauthorized" || e.code === "not_found") V.invalid(e.message);
      else V.invalid("Couldn’t load the setup page: " + e.message);
    }
  }

  async function startState() {
    loading();
    try {
      var data = await App.api.getState(token);
      route(data);
    } catch (e) {
      if (e.code === "unauthorized" || e.code === "not_found") V.invalid(e.message);
      else V.invalid("Couldn’t load this poll: " + e.message);
    }
  }

  function reload() { return startState(); }

  function route(data) {
    var ctx = { token: token, data: data, reload: reload };
    var state = (data.poll && data.poll.state) || "";
    var terminal = /booked|cancelled|closed/i.test(state);

    if (terminal) return V.closed(data);

    if (data.role === "organizer") {
      if (/pivot/i.test(state)) return V.pivot(ctx);
      if (/hold/i.test(state)) return V.hold(ctx);
      if (/escalate/i.test(state)) return V.escalate(ctx);
      return V.dashboard(ctx);
    }
    // invitee: one persistent page, whatever the (non-terminal) state
    return V.invitee(ctx);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
