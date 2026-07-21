/**
 * mail.js — GmailApp sending of every effect type, bodies/subjects from Sched.text.
 * A daily budget counter (~100/day, consumer Gmail) suppresses lowest-priority mail
 * first and surfaces the squeeze to the organizer dashboard.
 */

var Mail = {

  DAILY_BUDGET: 100,
  HIGH_THRESHOLD: 5, // priority >= this always sends, even over budget

  // effect type -> { recipient, view, textFn, priority }
  SPEC: {
    SEND_REMINDER:        { to: 'invitee',   view: '',         fn: 'reminder',       pri: 1 },
    SEND_ROUND2_ASK:      { to: 'invitee',   view: '',         fn: 'round2Ask',      pri: 2 },
    SEND_REQUIRED_GRACE:  { to: 'invitee',   view: '',         fn: 'requiredGrace',  pri: 3 },
    SEND_INVITE:          { to: 'invitee',   view: '',         fn: 'invite',         pri: 4 },
    SEND_PIVOT_PROPOSAL:  { to: 'organizer', view: 'launch',   fn: 'pivotProposal',  pri: 5 },
    SEND_ESCALATE:        { to: 'organizer', view: 'escalate', fn: 'escalate',       pri: 6 },
    SEND_REQUIRED_STUCK:  { to: 'organizer', view: 'required', fn: 'requiredStuck',  pri: 7 },
    SEND_HOLD_APPROVAL:   { to: 'organizer', view: 'hold',     fn: 'holdApproval',   pri: 8 },
    SEND_BOOKING_FAILED:  { to: 'organizer', view: '',         fn: 'bookingFailed',  pri: 9 }
  },

  _dayKey: function () {
    return 'EMAIL_USED_' + Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyyMMdd');
  },

  used: function () {
    return Number(PropertiesService.getScriptProperties().getProperty(this._dayKey()) || 0);
  },

  remaining: function () { return this.DAILY_BUDGET - this.used(); },

  _bump: function () {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(this._dayKey(), String(this.used() + 1));
  },

  squeezedToday: function () {
    var k = 'EMAIL_SQUEEZE_' + Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyyMMdd');
    return PropertiesService.getScriptProperties().getProperty(k) === '1';
  },

  _markSqueeze: function () {
    var k = 'EMAIL_SQUEEZE_' + Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyyMMdd');
    PropertiesService.getScriptProperties().setProperty(k, '1');
  },

  /**
   * Send one mail effect. Returns 'sent' | 'suppressed'.
   * Suppression (over budget, low priority) leaves the effect for the organizer to see.
   */
  send: function (effect, snapshot) {
    var spec = this.SPEC[effect.type];
    if (!spec) return 'sent'; // non-mail effect handled elsewhere
    if (this.remaining() <= 0 && spec.pri < this.HIGH_THRESHOLD) {
      this._markSqueeze();
      return 'suppressed';
    }
    var recipient = spec.to === 'organizer'
      ? organizerInvitee(snapshot)
      : inviteeById(snapshot, effect.inviteeId);
    if (!recipient) return 'sent';
    var link = linkFor(snapshot.poll, recipient.inviteeId);
    var msg = coreEmail(spec.fn, snapshot, recipient, link, effect);
    GmailApp.sendEmail(recipient.email, msg.subject, msg.body,
      { name: snapshot.poll.organizerName });
    this._bump();
    return 'sent';
  }
};

/** Resolve an email subject/body from Sched.text with a safe fallback. */
function coreEmail(fn, snapshot, invitee, link, effect) {
  try {
    var m = Sched.text.email[fn](snapshot, invitee, link, effect);
    if (m && m.subject && m.body) return m;
  } catch (e) { /* fall through */ }
  return {
    subject: snapshot.poll.title + ' — scheduling',
    body: 'Please open your scheduling page: ' + link +
      '\n\nSent on ' + snapshot.poll.organizerName + "'s behalf."
  };
}

function organizerInvitee(snapshot) {
  return snapshot.invitees.filter(function (i) { return i.organizer; })[0] || null;
}

function inviteeById(snapshot, id) {
  return snapshot.invitees.filter(function (i) { return i.inviteeId === id; })[0] || null;
}
