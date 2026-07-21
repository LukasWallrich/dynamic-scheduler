/**
 * store.js — Sheet-backed canonical storage.
 * Lazy-creates the spreadsheet + one tab per table on first use; the id is kept
 * in Script Properties. Loads the core Snapshot; appends votes/constraints/audit;
 * updates polls with a monotonic rev check (stale writes rejected); manages the
 * outbox with idempotency keys.
 */

var Store = {

  SS_PROP: 'SPREADSHEET_ID',

  TABLES: {
    polls: ['pollId', 'rev', 'state', 'title', 'durationMins', 'tz',
      'organizerEmail', 'organizerName', 'horizonStartUtc', 'horizonEndUtc',
      'whStartHour', 'whEndHour', 'whDays', 'visibility', 'minAttendees',
      'maxAbsences', 'slateVersion', 'round1DeadlineUtc', 'round2DeadlineUtc',
      'pivotDelayHours', 'pivotProposedAtUtc', 'launchApprovedAtUtc',
      'holdSlotId', 'holdStartedAtUtc', 'holdApprovedAtUtc', 'holdForced',
      'rescueAlternatesJson', 'requiredGraceUntilUtc', 'graceRound', 'holdJustification',
      'calendarEventId', 'linkBase', 'createdAtUtc'],
    invitees: ['pollId', 'inviteeId', 'name', 'email', 'required', 'demoted',
      'organizer', 'tokenHash'],
    slots: ['pollId', 'slotId', 'startUtc', 'endUtc', 'kind', 'slateVersion',
      'proposerInviteeId'],
    votes: ['pollId', 'inviteeId', 'slotId', 'answer', 'provenance', 'rev', 'atUtc'],
    constraints: ['pollId', 'inviteeId', 'type', 'value', 'atUtc'],
    outbox: ['key', 'pollId', 'type', 'payloadJson', 'status', 'attempts',
      'atUtc', 'claimedAtUtc'],
    audit: ['pollId', 'atUtc', 'event', 'detailJson']
  },

  // ---- spreadsheet / tab bootstrap ---------------------------------------

  spreadsheet: function () {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty(this.SS_PROP);
    if (id) {
      try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate below */ }
    }
    var ss = SpreadsheetApp.create('DynamicScheduler-Store');
    props.setProperty(this.SS_PROP, ss.getId());
    var defaultSheet = ss.getSheets()[0];
    Object.keys(this.TABLES).forEach(function (name) {
      var sh = ss.insertSheet(name);
      sh.appendRow(Store.TABLES[name]);
    });
    ss.deleteSheet(defaultSheet);
    return ss;
  },

  sheet: function (name) {
    var ss = this.spreadsheet();
    var sh = ss.getSheetByName(name);
    var want = this.TABLES[name];
    if (!sh) { sh = ss.insertSheet(name); sh.appendRow(want); return sh; }
    // Rows are read by the stored header but written in code-column order, so a header
    // that has drifted from the schema silently misaligns every later column. v1 test
    // data is disposable: on drift, repave the sheet with the current header rather than
    // serve corrupt reads. (A production store would migrate row-by-row instead.)
    var header = (sh.getLastRow() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : []);
    if (header.join('') !== want.join('')) {
      sh.clear();
      sh.appendRow(want);
    }
    return sh;
  },

  // ---- generic row helpers -----------------------------------------------

  _rows: function (name) {
    var sh = this.sheet(name);
    var values = sh.getDataRange().getValues();
    if (values.length < 2) return [];
    var header = values[0];
    var out = [];
    for (var r = 1; r < values.length; r++) {
      var obj = {};
      for (var c = 0; c < header.length; c++) obj[header[c]] = values[r][c];
      obj._row = r + 1;
      out.push(obj);
    }
    return out;
  },

  _append: function (name, obj) {
    var sh = this.sheet(name);
    var row = this.TABLES[name].map(function (col) {
      var v = obj[col];
      return v === undefined || v === null ? '' : v;
    });
    sh.appendRow(row);
  },

  _writeRow: function (name, rowIndex, obj) {
    var sh = this.sheet(name);
    var row = this.TABLES[name].map(function (col) {
      var v = obj[col];
      return v === undefined || v === null ? '' : v;
    });
    sh.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  },

  // ---- snapshot ----------------------------------------------------------

  loadSnapshot: function (pollId) {
    var pRow = this._rows('polls').filter(function (r) { return r.pollId === pollId; })[0];
    if (!pRow) return null;
    var poll = {
      pollId: pRow.pollId,
      rev: Number(pRow.rev),
      state: pRow.state,
      title: pRow.title,
      durationMins: Number(pRow.durationMins),
      tz: pRow.tz,
      organizerEmail: pRow.organizerEmail,
      organizerName: pRow.organizerName,
      horizonStartUtc: Number(pRow.horizonStartUtc),
      horizonEndUtc: Number(pRow.horizonEndUtc),
      workingHours: {
        startHour: Number(pRow.whStartHour),
        endHour: Number(pRow.whEndHour),
        days: String(pRow.whDays).split(',').filter(String).map(Number)
      },
      visibility: pRow.visibility,
      minAttendees: Number(pRow.minAttendees),
      maxAbsences: Number(pRow.maxAbsences),
      slateVersion: Number(pRow.slateVersion),
      round1DeadlineUtc: numOrNull(pRow.round1DeadlineUtc),
      round2DeadlineUtc: numOrNull(pRow.round2DeadlineUtc),
      pivotDelayHours: Number(pRow.pivotDelayHours),
      pivotProposedAtUtc: numOrNull(pRow.pivotProposedAtUtc),
      launchApprovedAtUtc: numOrNull(pRow.launchApprovedAtUtc),
      holdSlotId: pRow.holdSlotId || null,
      holdStartedAtUtc: numOrNull(pRow.holdStartedAtUtc),
      holdApprovedAtUtc: numOrNull(pRow.holdApprovedAtUtc),
      holdForced: pRow.holdForced === true || pRow.holdForced === 'TRUE',
      rescueAlternatesJson: pRow.rescueAlternatesJson || '',
      requiredGraceUntilUtc: numOrNull(pRow.requiredGraceUntilUtc),
      graceRound: numOrNull(pRow.graceRound),
      calendarEventId: pRow.calendarEventId || null,
      linkBase: pRow.linkBase || '',
      createdAtUtc: numOrNull(pRow.createdAtUtc)
    };
    var byPoll = function (r) { return r.pollId === pollId; };
    return {
      poll: poll,
      invitees: this._rows('invitees').filter(byPoll).map(function (r) {
        return {
          inviteeId: r.inviteeId, name: r.name, email: r.email,
          required: r.required === true || r.required === 'TRUE',
          demoted: r.demoted === true || r.demoted === 'TRUE',
          organizer: r.organizer === true || r.organizer === 'TRUE'
        };
      }),
      slots: this._rows('slots').filter(byPoll).map(function (r) {
        return {
          slotId: r.slotId, startUtc: Number(r.startUtc), endUtc: Number(r.endUtc),
          kind: r.kind, slateVersion: Number(r.slateVersion),
          proposerInviteeId: r.proposerInviteeId || null
        };
      }),
      votes: this._rows('votes').filter(byPoll).map(function (r) {
        return {
          inviteeId: r.inviteeId, slotId: r.slotId, answer: r.answer,
          provenance: r.provenance, rev: Number(r.rev), atUtc: Number(r.atUtc)
        };
      }),
      constraints: this._rows('constraints').filter(byPoll).map(function (r) {
        return {
          inviteeId: r.inviteeId, type: r.type, value: r.value, atUtc: Number(r.atUtc)
        };
      })
    };
  },

  activePollIds: function () {
    var ACTIVE = { ROUND1: 1, PIVOT_PENDING: 1, ROUND2: 1, REQUIRED_GRACE: 1,
      HOLD: 1, BOOKING: 1 };
    return this._rows('polls')
      .filter(function (r) { return ACTIVE[r.state]; })
      .map(function (r) { return r.pollId; });
  },

  // ---- writers -----------------------------------------------------------

  insertPoll: function (poll, invitees, slots) {
    this._append('polls', poll);
    invitees.forEach(function (i) { Store._append('invitees', i); });
    slots.forEach(function (s) { Store._append('slots', s); });
  },

  /** Commit a poll patch under an optimistic rev check. Throws on stale. */
  updatePoll: function (pollId, patch, expectedRev) {
    var rows = this._rows('polls');
    var row = rows.filter(function (r) { return r.pollId === pollId; })[0];
    if (!row) throw new Error('poll not found: ' + pollId);
    if (Number(row.rev) !== Number(expectedRev)) {
      throw { stale: true, message: 'rev mismatch', have: Number(row.rev), expected: expectedRev };
    }
    Object.keys(patch).forEach(function (k) {
      var col = Store._pollColumn(k);
      if (col) row[col] = patch[k];
    });
    row.rev = Number(expectedRev) + 1;
    this._writeRow('polls', row._row, row);
    return row.rev;
  },

  _pollColumn: function (patchKey) {
    var map = {
      startHour: null, endHour: null, days: null, workingHours: null,
      round1DeadlineUtc: 'round1DeadlineUtc', round2DeadlineUtc: 'round2DeadlineUtc'
    };
    if (patchKey in map) return map[patchKey];
    return this.TABLES.polls.indexOf(patchKey) >= 0 ? patchKey : null;
  },

  appendVotes: function (pollId, inviteeId, votes) {
    var now = Date.now();
    votes.forEach(function (v) {
      Store._append('votes', {
        pollId: pollId, inviteeId: inviteeId, slotId: v.slotId, answer: v.answer,
        provenance: v.provenance, rev: v.rev || now, atUtc: now
      });
    });
  },

  /**
   * Replace one invitee's whole constraint set (avoid-rules). The frontend always
   * sends the full current set on save, so an empty array genuinely clears rules —
   * append-only storage made cleared rules haunt pivot scoring forever.
   */
  replaceConstraints: function (pollId, inviteeId, constraints) {
    var sh = this.sheet('constraints');
    var stale = this._rows('constraints').filter(function (r) {
      return r.pollId === pollId && r.inviteeId === inviteeId;
    });
    for (var i = stale.length - 1; i >= 0; i--) sh.deleteRow(stale[i]._row); // bottom-up
    var now = Date.now();
    constraints.forEach(function (c) {
      Store._append('constraints', {
        pollId: pollId, inviteeId: inviteeId, type: c.type, value: c.value, atUtc: now
      });
    });
  },

  appendSlots: function (pollId, slots) {
    slots.forEach(function (s) { Store._append('slots', {
      pollId: pollId, slotId: s.slotId, startUtc: s.startUtc, endUtc: s.endUtc,
      kind: s.kind, slateVersion: s.slateVersion,
      proposerInviteeId: s.proposerInviteeId || ''
    }); });
  },

  applySlotPatches: function (pollId, slotPatches) {
    if (!slotPatches || !slotPatches.length) return;
    var rows = this._rows('slots').filter(function (r) { return r.pollId === pollId; });
    slotPatches.forEach(function (p) {
      var row = rows.filter(function (r) { return r.slotId === p.slotId; })[0];
      if (!row) return;
      Object.keys(p).forEach(function (k) { if (k in row) row[k] = p[k]; });
      Store._writeRow('slots', row._row, row);
    });
  },

  appendAudit: function (pollId, event, detail) {
    this._append('audit', {
      pollId: pollId, atUtc: Date.now(), event: event,
      detailJson: JSON.stringify(detail || {})
    });
  },

  // ---- invitees / tokens -------------------------------------------------

  findInviteeByToken: function (pollId, token) {
    var hash = Security.hashToken(token);
    return this._rows('invitees').filter(function (r) {
      return r.pollId === pollId && Security.hashEquals(String(r.tokenHash), hash);
    })[0] || null;
  },

  /**
   * Resolve a raw token to its invitee row across ALL polls — the JSON API carries only a
   * token (no pollId), so the poll is discovered from the token. Token hashes are 256-bit
   * random and globally unique, so at most one row matches; the row carries its pollId.
   */
  findInviteeByTokenAny: function (token) {
    var hash = Security.hashToken(token);
    return this._rows('invitees').filter(function (r) {
      return Security.hashEquals(String(r.tokenHash), hash);
    })[0] || null;
  },

  // ---- raw tokens (Script Properties, never the Sheet) -------------------
  // Keyed 'tokens:<pollId>' -> JSON map inviteeId -> raw token. The Sheet keeps
  // only the hash; the raw form is needed solely to rebuild reminder/round-2 links.

  _tokenPropKey: function (pollId) { return 'tokens:' + pollId; },

  setTokens: function (pollId, map) {
    PropertiesService.getScriptProperties()
      .setProperty(this._tokenPropKey(pollId), JSON.stringify(map || {}));
  },

  getTokens: function (pollId) {
    var v = PropertiesService.getScriptProperties().getProperty(this._tokenPropKey(pollId));
    return v ? JSON.parse(v) : {};
  },

  inviteeToken: function (pollId, inviteeId) {
    return this.getTokens(pollId)[inviteeId] || null;
  },

  /** Drop the raw-token map once a poll is terminal; stale links go to the closed page. */
  deleteTokens: function (pollId) {
    PropertiesService.getScriptProperties().deleteProperty(this._tokenPropKey(pollId));
  },

  rotateToken: function (pollId, inviteeId) {
    var rows = this._rows('invitees');
    var row = rows.filter(function (r) {
      return r.pollId === pollId && r.inviteeId === inviteeId;
    })[0];
    if (!row) return null;
    var token = Security.newToken();
    row.tokenHash = Security.hashToken(token);
    this._writeRow('invitees', row._row, row);
    var map = this.getTokens(pollId);
    map[inviteeId] = token;
    this.setTokens(pollId, map);
    return token;
  },

  demoteInvitee: function (pollId, inviteeId) {
    var rows = this._rows('invitees');
    var row = rows.filter(function (r) {
      return r.pollId === pollId && r.inviteeId === inviteeId;
    })[0];
    if (!row) return;
    row.required = false;
    row.demoted = true;
    this._writeRow('invitees', row._row, row);
  },

  // ---- outbox ------------------------------------------------------------

  enqueueEffect: function (pollId, effect) {
    if (!effect || !effect.idempotencyKey) return;
    if (this.outboxByKey(effect.idempotencyKey)) return; // already queued
    this._append('outbox', {
      key: effect.idempotencyKey, pollId: pollId, type: effect.type,
      payloadJson: JSON.stringify(effect), status: 'pending', attempts: 0,
      atUtc: Date.now(), claimedAtUtc: ''
    });
  },

  outboxByKey: function (key) {
    return this._rows('outbox').filter(function (r) { return r.key === key; })[0] || null;
  },

  /**
   * Atomically claim this run's pending rows: flip pending -> executing (stamping
   * claimedAtUtc) and return the claimed rows. Called inside the ScriptLock so a
   * concurrent invocation cannot claim the same row and double-send.
   */
  claimOutbox: function (pollId) {
    var now = Date.now();
    var claimed = this._rows('outbox').filter(function (r) {
      return r.pollId === pollId && r.status === 'pending';
    });
    claimed.forEach(function (r) {
      r.status = 'executing';
      r.claimedAtUtc = now;
      Store._writeRow('outbox', r._row, r);
    });
    return claimed.map(function (r) {
      return { key: r.key, pollId: r.pollId, type: r.type,
        payloadJson: r.payloadJson, attempts: Number(r.attempts) };
    });
  },

  /**
   * `executing` rows whose claim is older than maxAgeMs — crashed mid-send. `type` filters
   * to one effect type; pass null/undefined to return every stale executing row.
   */
  staleExecuting: function (maxAgeMs, type) {
    var cutoff = Date.now() - maxAgeMs;
    return this._rows('outbox').filter(function (r) {
      return r.status === 'executing' && (type == null || r.type === type) &&
        r.claimedAtUtc !== '' && r.claimedAtUtc !== null &&
        Number(r.claimedAtUtc) < cutoff;
    });
  },

  markOutbox: function (key, status, attempts) {
    var rows = this._rows('outbox');
    var row = rows.filter(function (r) { return r.key === key; })[0];
    if (!row) return;
    row.status = status;
    row.attempts = attempts;
    if (status === 'pending') row.claimedAtUtc = ''; // re-queue for the next claim
    this._writeRow('outbox', row._row, row);
  }
};

function numOrNull(v) {
  return (v === '' || v === null || v === undefined) ? null : Number(v);
}
