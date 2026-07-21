/**
 * calendar.js — organizer free/busy and event creation.
 * Free/busy comes from the organizer's default calendar via the advanced Calendar
 * service (Freebusy already honours the blocking policy: shows-as-Busy blocks;
 * declined / free-marked / working-location events do not; all-day only if Busy).
 * isSlotFree is the live recheck used at render, vote, HOLD, approval, and booking.
 */

var Cal = {

  /** Busy intervals [{startUtc,endUtc}] on the organizer calendar in [fromUtc,toUtc). */
  busyIntervals: function (organizerEmail, fromUtc, toUtc) {
    var resp = Calendar.Freebusy.query({
      timeMin: new Date(fromUtc).toISOString(),
      timeMax: new Date(toUtc).toISOString(),
      items: [{ id: organizerEmail }]
    });
    var cal = resp.calendars[organizerEmail] || { busy: [] };
    return (cal.busy || []).map(function (b) {
      return { startUtc: new Date(b.start).getTime(), endUtc: new Date(b.end).getTime() };
    });
  },

  /**
   * Organizer-free windows inside working hours across the horizon:
   * per working day, take the working-hours interval and subtract busy blocks.
   */
  freeWindows: function (poll) {
    var busy = this.busyIntervals(poll.organizerEmail, poll.horizonStartUtc, poll.horizonEndUtc);
    var wh = poll.workingHours;
    var dayWindows = [];
    var cursor = startOfDayInTz(poll.horizonStartUtc, poll.tz);
    var DAY = 24 * 3600 * 1000;
    while (cursor < poll.horizonEndUtc) {
      var dow = dowInTz(cursor, poll.tz); // 0-6
      if (wh.days.indexOf(dow) >= 0) {
        var s = setHourInTz(cursor, poll.tz, wh.startHour);
        var e = setHourInTz(cursor, poll.tz, wh.endHour);
        s = Math.max(s, poll.horizonStartUtc);
        e = Math.min(e, poll.horizonEndUtc);
        if (e > s) dayWindows.push({ startUtc: s, endUtc: e });
      }
      cursor += DAY;
    }
    var free = [];
    dayWindows.forEach(function (w) {
      var pieces = [{ startUtc: w.startUtc, endUtc: w.endUtc }];
      busy.forEach(function (b) {
        pieces = subtract(pieces, b);
      });
      free = free.concat(pieces);
    });
    return free;
  },

  /** Live recheck: true if no busy block overlaps the slot. */
  isSlotFree: function (poll, slot) {
    var busy = this.busyIntervals(poll.organizerEmail, slot.startUtc, slot.endUtc);
    for (var i = 0; i < busy.length; i++) {
      if (busy[i].startUtc < slot.endUtc && busy[i].endUtc > slot.startUtc) return false;
    }
    return true;
  },

  /**
   * Reconciliation search: an event on the deployer's default calendar matching this
   * slot's exact window and the poll title. Returns its id, or null if none exists —
   * lets a crashed CREATE_EVENT be resolved without risking a duplicate booking.
   */
  findEvent: function (poll, slot) {
    var events = CalendarApp.getDefaultCalendar().getEvents(
      new Date(slot.startUtc - 60000), new Date(slot.endUtc + 60000));
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.getTitle() === poll.title &&
        ev.getStartTime().getTime() === slot.startUtc &&
        ev.getEndTime().getTime() === slot.endUtc) return ev.getId();
    }
    return null;
  },

  /** Create the meeting on the deployer's default calendar, inviting ALL invitees. */
  createEvent: function (poll, slot, invitees, description) {
    var guests = invitees.map(function (i) { return i.email; }).join(',');
    var event = CalendarApp.getDefaultCalendar().createEvent(
      poll.title,
      new Date(slot.startUtc),
      new Date(slot.endUtc),
      { guests: guests, sendInvites: true, description: description });
    return event.getId();
  }
};

// --- interval math -----------------------------------------------------------

function subtract(pieces, b) {
  var out = [];
  pieces.forEach(function (p) {
    if (b.endUtc <= p.startUtc || b.startUtc >= p.endUtc) { out.push(p); return; }
    if (b.startUtc > p.startUtc) out.push({ startUtc: p.startUtc, endUtc: b.startUtc });
    if (b.endUtc < p.endUtc) out.push({ startUtc: b.endUtc, endUtc: p.endUtc });
  });
  return out;
}

// --- timezone helpers (via Utilities.formatDate in the poll tz) --------------

function tzParts(utc, tz) {
  var d = new Date(utc);
  return {
    y: Number(Utilities.formatDate(d, tz, 'yyyy')),
    mo: Number(Utilities.formatDate(d, tz, 'MM')),
    da: Number(Utilities.formatDate(d, tz, 'dd')),
    h: Number(Utilities.formatDate(d, tz, 'HH')),
    mi: Number(Utilities.formatDate(d, tz, 'mm')),
    dow: Number(Utilities.formatDate(d, tz, 'u')) % 7 // u: 1=Mon..7=Sun -> 0..6, Sun=0
  };
}

function dowInTz(utc, tz) { return tzParts(utc, tz).dow; }

function startOfDayInTz(utc, tz) {
  var p = tzParts(utc, tz);
  return isoToUtc(p.y, p.mo, p.da, 0, 0, tz);
}

function setHourInTz(utc, tz, hour) {
  var p = tzParts(utc, tz);
  return isoToUtc(p.y, p.mo, p.da, hour, 0, tz);
}

/** Build a UTC instant from wall-clock parts in a timezone. */
function isoToUtc(y, mo, da, h, mi, tz) {
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var wall = y + '-' + pad(mo) + '-' + pad(da) + ' ' + pad(h) + ':' + pad(mi) + ':00';
  // Utilities.parseDate interprets the wall string in tz and returns the instant.
  return Utilities.parseDate(wall, tz, 'yyyy-MM-dd HH:mm:ss').getTime();
}
