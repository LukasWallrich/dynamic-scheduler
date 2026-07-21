import { Sched } from "./_load.mjs";

const HOUR = 3600000;
const MIN = 60000;

/** London is BST (UTC+1) throughout the reference journey (July, no DST span). */
export function londonToUtc(y, mo, d, h, mi = 0) {
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi);
  const off = Sched.universe.tzOffset(guessUtc, "Europe/London");
  return guessUtc - off;
}

/**
 * A minimal in-memory shell around the pure core: holds a snapshot, a scripted clock,
 * and an idempotency-deduped outbox — exactly the loop gas/advance.js runs.
 */
export class World {
  constructor(snapshot, now) {
    this.snapshot = snapshot;
    this.now = now;
    this.rev = 1;
    this.emitted = new Set();
    this.sent = []; // {type, key, inviteeId, ...}
    this.created = []; // CREATE_EVENT effects executed
  }

  setNow(now) { this.now = now; }

  _nextVoteRev() { return ++this.rev; }

  addVotes(inviteeId, votes) {
    const at = this.now;
    votes.forEach((v) => {
      this.snapshot.votes.push({
        inviteeId, slotId: v.slotId, answer: v.answer,
        provenance: v.provenance || "explicit_slate",
        rev: this._nextVoteRev(), atUtc: at
      });
    });
  }

  addConstraints(inviteeId, constraints) {
    const at = this.now;
    constraints.forEach((c) => {
      this.snapshot.constraints.push({ inviteeId, type: c.type, value: c.value, atUtc: at });
    });
  }

  addBench(inviteeId, slots) {
    const made = slots.map((s, i) => ({
      slotId: `bench_${inviteeId}_${this.now}_${i}`,
      startUtc: s.startUtc, endUtc: s.endUtc, kind: "bench",
      slateVersion: this.snapshot.poll.slateVersion, proposerInviteeId: inviteeId
    }));
    made.forEach((s) => this.snapshot.slots.push(s));
    this.addVotes(inviteeId, made.map((s) => ({ slotId: s.slotId, answer: "works", provenance: "proposal" })));
    return made;
  }

  /**
   * Persist a computed rescue slate as slateVersion-2 slots (the shell's pivot job).
   * A promoted bench slot carries its existing votes forward as revisable prefills.
   */
  installRescueSlate(proposals) {
    const latest = Sched.votes.latest(this.snapshot);
    return proposals.map((p, i) => {
      const bench = p.benchSlotId
        ? this.snapshot.slots.filter((s) => s.slotId === p.benchSlotId)[0]
        : this.snapshot.slots.filter((s) => s.kind === "bench" && s.startUtc === p.startUtc)[0];
      const slot = {
        slotId: `slate2_${i}`, startUtc: p.startUtc, endUtc: p.endUtc,
        kind: "slate2", slateVersion: 2,
        proposerInviteeId: bench ? bench.proposerInviteeId : "", reasoning: p.reasoning
      };
      this.snapshot.slots.push(slot);
      if (bench) {
        this.snapshot.invitees.forEach((inv) => {
          const v = latest.get(Sched.votes.keyOf(inv.inviteeId, bench.slotId));
          if (!v) return;
          const provenance = inv.inviteeId === bench.proposerInviteeId ? "proposal" : "prefill";
          this.snapshot.votes.push({
            inviteeId: inv.inviteeId, slotId: slot.slotId, answer: v.answer,
            provenance, rev: this._nextVoteRev(), atUtc: this.now
          });
        });
      }
      return slot;
    });
  }

  _applyPollPatch(patch) {
    Object.keys(patch).forEach((k) => {
      this.snapshot.poll[k] = patch[k] === null ? null : patch[k];
    });
  }

  _applySlotPatches(patches) {
    patches.forEach((p) => {
      const row = this.snapshot.slots.filter((s) => s.slotId === p.slotId)[0];
      if (!row) return;
      Object.keys(p).forEach((k) => { if (k !== "slotId") row[k] = p[k]; });
    });
  }

  /** Run advance until no transition; return the NEW (not-yet-emitted) effects. */
  run() {
    const fresh = [];
    for (let i = 0; i < 40; i++) {
      const res = Sched.engine.advance(this.snapshot, this.now);
      const pollPatch = res.pollPatch || {};
      const slotPatches = res.slotPatches || [];
      const effects = res.effects || [];
      const voteRecords = res.voteRecords || [];
      const stateChanged = res.state && res.state !== this.snapshot.poll.state;
      const patched = stateChanged || Object.keys(pollPatch).length > 0 ||
        slotPatches.length > 0 || voteRecords.length > 0;

      effects.forEach((e) => {
        if (this.emitted.has(e.idempotencyKey)) return;
        this.emitted.add(e.idempotencyKey);
        fresh.push(e);
        this._execute(e);
      });

      if (patched) {
        this._applyPollPatch(pollPatch);
        if (stateChanged) this.snapshot.poll.state = res.state;
        this._applySlotPatches(slotPatches);
        // The shell persists transition-created votes exactly like action votes.
        voteRecords.forEach((vr) => {
          this.snapshot.votes.push({
            inviteeId: vr.inviteeId, slotId: vr.slotId, answer: vr.answer,
            provenance: vr.provenance || "prefill", rev: this._nextVoteRev(), atUtc: this.now
          });
        });
        this.rev += 1;
      } else {
        break;
      }
    }
    return fresh;
  }

  _execute(e) {
    if (e.type === "CREATE_EVENT") {
      this.created.push(e);
      // The shell books the event and records the id, then re-advances -> BOOKED.
      this.snapshot.poll.calendarEventId = "evt_" + e.slotId;
      this.run();
    } else {
      this.sent.push(e);
    }
  }

  get state() { return this.snapshot.poll.state; }

  slotStatus(slotId) { return Sched.engine.slotStatus(this.snapshot, slotId, this.now).status; }

  effectsOfType(type) { return this.sent.filter((e) => e.type === type); }

  mailCountFor(inviteeId) {
    return this.sent.filter((e) => e.inviteeId === inviteeId).length;
  }
}

export const T = { HOUR, MIN };
