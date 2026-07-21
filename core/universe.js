var Sched = globalThis.Sched = globalThis.Sched || {};

var MS_PER_MIN = 60000;
var MS_PER_HOUR = 3600000;
var MS_PER_DAY = 86400000;

/** Wall-clock parts of an instant in a given IANA timezone. weekday: 0=Sun..6=Sat. */
function localParts(ms, tz) {
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  var p = {};
  dtf.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  var wdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: wdays[p.weekday],
    dateKey: p.year + "-" + p.month + "-" + p.day
  };
}

/** Timezone offset (local - UTC) in ms for an instant. */
function tzOffset(ms, tz) {
  var p = localParts(ms, tz);
  var asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // localParts is second-precision; a millisecond-bearing `ms` (e.g. Date.now()) would
  // otherwise leave a sub-second remainder. Real tz offsets are whole minutes, so round —
  // without this, spansDst falsely fires on any non-second-aligned horizon.
  return Math.round((asUtc - ms) / 60000) * 60000;
}

/** True if the instant is inside working hours on a working day. */
function inWorkingHours(ms, workingHours, tz) {
  var p = localParts(ms, tz);
  if (workingHours.days.indexOf(p.weekday) < 0) return false;
  var hourFloat = p.hour + p.minute / 60;
  return hourFloat >= workingHours.startHour && hourFloat < workingHours.endHour;
}

/** Instant `hours` of working time after `startMs`, per the working-hours calendar. */
function addWorkingHours(startMs, hours, workingHours, tz) {
  var remaining = hours * MS_PER_HOUR;
  var t = startMs;
  var step = 15 * MS_PER_MIN;
  var guard = 0;
  while (remaining > 0 && guard++ < 4000) {
    if (inWorkingHours(t, workingHours, tz)) remaining -= step;
    t += step;
  }
  return t;
}

Sched.universe = {
  localParts: localParts,
  tzOffset: tzOffset,
  inWorkingHours: inWorkingHours,
  addWorkingHours: addWorkingHours,

  /** All aligned duration-length starts inside working hours, horizon, and a free window. */
  candidateStarts: function (poll, freeWindows) {
    var dur = poll.durationMins * MS_PER_MIN;
    var align = 30 * MS_PER_MIN;
    var starts = [];
    var seen = {};
    (freeWindows || []).forEach(function (w) {
      var first = Math.ceil(w.startUtc / align) * align;
      for (var s = first; s + dur <= w.endUtc; s += align) {
        if (s < poll.horizonStartUtc || s + dur > poll.horizonEndUtc) continue;
        var endLocalOk = inWorkingHours(s, poll.workingHours, poll.tz) &&
          isWithinWorkingDay(s + dur, poll.workingHours, poll.tz);
        if (!endLocalOk) continue;
        if (seen[s]) continue;
        seen[s] = true;
        starts.push(s);
      }
    });
    return starts.sort(function (a, b) { return a - b; });
  },

  /** True if the horizon crosses a DST transition in the event timezone. */
  spansDst: function (poll) {
    var base = tzOffset(poll.horizonStartUtc, poll.tz);
    for (var t = poll.horizonStartUtc; t <= poll.horizonEndUtc; t += MS_PER_DAY) {
      if (tzOffset(t, poll.tz) !== base) return true;
    }
    return tzOffset(poll.horizonEndUtc, poll.tz) !== base;
  }
};

/** The end of a meeting may land exactly on endHour; allow it. */
function isWithinWorkingDay(ms, workingHours, tz) {
  var p = localParts(ms, tz);
  if (workingHours.days.indexOf(p.weekday) < 0) return false;
  var hourFloat = p.hour + p.minute / 60;
  return hourFloat > workingHours.startHour && hourFloat <= workingHours.endHour;
}

if (typeof module !== "undefined") module.exports = Sched;
