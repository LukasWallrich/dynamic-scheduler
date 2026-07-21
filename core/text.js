var Sched = globalThis.Sched = globalThis.Sched || {};

var WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n) { return n < 10 ? "0" + n : "" + n; }

/** e.g. "Tue 21 Jul 2026, 14:00 (Europe/London)". */
function whenLabel(ms, tz) {
  var p = Sched.universe.localParts(ms, tz);
  return WEEKDAY[p.weekday] + " " + p.day + " " + MONTH[p.month - 1] + " " + p.year +
    ", " + pad(p.hour) + ":" + pad(p.minute) + " (" + tz + ")";
}

function signoff(poll) {
  return "Sent on " + poll.organizerName + "'s behalf by Dynamic Scheduler.";
}

function socialContract(poll) {
  return "If none of these work, we'll propose up to 3 alternatives automatically.";
}

function inviteeSlots(snapshot) {
  return Sched.engine.liveSlots(snapshot);
}

function organizer(snapshot) {
  return snapshot.invitees.filter(function (i) { return i.organizer; })[0];
}

function slotLine(snapshot, slot) {
  return "- " + whenLabel(slot.startUtc, snapshot.poll.tz);
}

function inviteeBody(snapshot, invitee, link, lead) {
  var poll = snapshot.poll;
  var lines = inviteeSlots(snapshot).map(function (s) { return slotLine(snapshot, s); });
  return [
    "Hi " + firstName(invitee.name) + ",",
    "",
    lead,
    "",
    lines.join("\n"),
    "",
    "Please pick Works / If needed / Can't for each: " + link,
    "Deadline: " + whenLabel(deadlineOf(poll), poll.tz) + ".",
    "",
    socialContract(poll),
    "",
    signoff(poll)
  ].join("\n");
}

function firstName(name) { return (name || "").split(" ")[0]; }

function deadlineOf(poll) {
  return poll.slateVersion === 2 ? poll.round2DeadlineUtc : poll.round1DeadlineUtc;
}

function namesWithAnswer(snapshot, slotId, answer) {
  var latest = Sched.votes.latest(snapshot);
  return snapshot.invitees.filter(function (inv) {
    var v = latest.get(Sched.votes.keyOf(inv.inviteeId, slotId));
    return v && v.answer === answer;
  }).map(function (i) { return i.name; });
}

function bindingPeople(snapshot) {
  var names = {};
  Sched.engine.liveSlots(snapshot).forEach(function (s) {
    Sched.engine.slotStatus(snapshot, s.slotId, s.startUtc).reasons.forEach(function (r) {
      r.inviteeIds.forEach(function (id) {
        var inv = snapshot.invitees.filter(function (i) { return i.inviteeId === id; })[0];
        if (inv) names[inv.name] = true;
      });
    });
  });
  (snapshot.constraints || []).forEach(function (c) {
    var inv = snapshot.invitees.filter(function (i) { return i.inviteeId === c.inviteeId; })[0];
    if (inv) names[inv.name] = true;
  });
  return Object.keys(names);
}

Sched.text = {
  when: whenLabel,

  email: {
    invite: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      return {
        subject: poll.title + " — please pick times",
        body: inviteeBody(snapshot, invitee, link,
          poll.organizerName + " is scheduling \"" + poll.title + "\" (" +
          poll.durationMins + " min).")
      };
    },

    reminder: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      return {
        subject: "Reminder: " + poll.title + " — please pick times",
        body: inviteeBody(snapshot, invitee, link,
          "Quick reminder — please pick your times for \"" + poll.title + "\".")
      };
    },

    round2Ask: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      return {
        subject: poll.title + " — a couple more times to check",
        body: inviteeBody(snapshot, invitee, link,
          "The first times didn't work out — here are a few alternatives for \"" +
          poll.title + "\".")
      };
    },

    requiredGrace: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      return {
        subject: poll.title + " — we still need your times",
        body: inviteeBody(snapshot, invitee, link,
          "We can't lock in \"" + poll.title + "\" without your answer — about 24 hours left.")
      };
    },

    pivotProposal: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      var slots = Sched.engine.liveSlots(snapshot)
        .filter(function (s) { return s.slateVersion === 2; });
      var lines = slots.map(function (s) {
        var st = Sched.engine.slotStatus(snapshot, s.slotId, s.startUtc);
        var works = namesWithAnswer(snapshot, s.slotId, "works");
        var why = st.reasons.map(function (r) { return r.text; }).join("; ");
        return "- " + whenLabel(s.startUtc, poll.tz) +
          (works.length ? " — works for " + works.join(", ") : "") +
          (why ? " — " + why : "");
      });
      return {
        subject: poll.title + " — pick the rescue times and launch",
        body: [
          "The first slate can't reach " + poll.minAttendees + " people, so here's a rescue slate.",
          "You vote first (prefilled to Works from your free windows), then it goes to invitees:",
          "",
          lines.join("\n"),
          "",
          "Review and launch: " + link,
          "",
          signoff(poll)
        ].join("\n")
      };
    },

    holdApproval: function (snapshot, invitee, link, effect) {
      var poll = snapshot.poll;
      var slotId = (effect && effect.slotId) || poll.holdSlotId;
      var slot = snapshot.slots.filter(function (s) { return s.slotId === slotId; })[0];
      var covers = namesWithAnswer(snapshot, slotId, "works")
        .concat(namesWithAnswer(snapshot, slotId, "ifneeded"));
      var cants = namesWithAnswer(snapshot, slotId, "cant");
      return {
        subject: poll.title + " — ready to book, please confirm",
        body: [
          "\"" + poll.title + "\" is ready to book for:",
          whenLabel(slot.startUtc, poll.tz) + ".",
          "",
          "Covers: " + (covers.length ? covers.join(", ") : "no confirmed attendees yet") + ".",
          cants.length ? "Said Can't (may report a clash): " + cants.join(", ") + "." : "",
          "",
          "Approve or reject: " + link,
          "No reply books it automatically in 24 hours.",
          "",
          signoff(poll)
        ].filter(Boolean).join("\n")
      };
    },

    requiredStuck: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      var latest = Sched.votes.latest(snapshot);
      var live = Sched.engine.liveSlots(snapshot).filter(function (s) {
        return s.kind !== "bench" && s.slateVersion === snapshot.poll.slateVersion;
      });
      var silent = snapshot.invitees.filter(function (inv) {
        if (!(inv.required && !inv.demoted)) return false;
        // Missing a vote on any live current-slate slot -> still needed (per-slot silence).
        return live.some(function (s) {
          return !latest.get(Sched.votes.keyOf(inv.inviteeId, s.slotId));
        });
      }).map(function (i) { return i.name; });
      return {
        subject: poll.title + " — a required person still hasn't replied",
        body: [
          "Still waiting on: " + silent.join(", ") + ".",
          "\"" + poll.title + "\" can't resolve without them. Your options:",
          "- extend another 24 hours",
          "- demote them to optional (the poll resolves without them)",
          "- chase them directly",
          "- cancel the poll",
          "",
          "Choose: " + link,
          "",
          signoff(poll)
        ].join("\n")
      };
    },

    escalate: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      return {
        subject: poll.title + " — no time worked, your call",
        body: [
          Sched.text.page.escalateDiagnosis(snapshot),
          "",
          "Your options:",
          "- relax the rule (lower the attendee floor or allow more absences)",
          "- extend the horizon",
          "- book the least-bad slot",
          "- cancel",
          "",
          "Decide: " + link,
          "",
          signoff(poll)
        ].join("\n")
      };
    },

    bookingFailed: function (snapshot, invitee, link) {
      var poll = snapshot.poll;
      return {
        subject: poll.title + " — booking didn't go through",
        body: [
          "The calendar event for \"" + poll.title + "\" couldn't be created, so nothing was booked.",
          "Please try again from: " + link,
          "",
          signoff(poll)
        ].join("\n")
      };
    },

    bookingDescription: function (snapshot) {
      var poll = snapshot.poll;
      return "Scheduled via Dynamic Scheduler for " + poll.organizerName +
        ". If this no longer works, decline and contact " + poll.organizerEmail + ".";
    }
  },

  page: {
    vetoStripLabel: function () {
      return "Days that never work, or dates you’re away?";
    },

    contract: function (snapshot) {
      return socialContract(snapshot.poll);
    },

    escalateDiagnosis: function (snapshot) {
      var poll = snapshot.poll;
      var people = bindingPeople(snapshot);
      var rule = "no slot reaches " + poll.minAttendees + " attendees within the rule";
      var who = people.length ? " " + people.join(", ") + (people.length > 1 ? " are binding." : " is binding.") : "";
      return rule + "." + (who ? " Binding:" + who : "");
    }
  }
};

if (typeof module !== "undefined") module.exports = Sched;
