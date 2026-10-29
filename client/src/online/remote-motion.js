/** Bounded snapshot storage for OpenMS mob presentation. */
const SAMPLE_CAPACITY = 32;
/** Playout adapts between these bounds. A dense per-tick stream converges to ~60 ms, enough
 *  to absorb jitter without rendering an extrapolated frame. */
const MIN_PLAYOUT_MS = 60;
const MAX_PLAYOUT_MS = 320;
const BASE_PLAYOUT_MS = 120;
const PLAYOUT_GAIN = 1.6;
const JITTER_GAIN = 2;
/** Playout changes are slewed so a buffer adjustment never becomes a visible speed change. */
const PLAYOUT_SLEW_MS_PER_SECOND = 90;
const MIN_INTERVAL_MS = 20;
const MAX_INTERVAL_MS = 200;
/** Extrapolation is bounded to one publication interval plus a short run-down, so a dry
 *  buffer eases to rest instead of sliding for 600 ms or freezing abruptly. */
const MAX_EXTRAP_MS = 120;
const COAST_TAU_MS = 200;
/** The drawn pose chases the buffered target along the error vector at one bounded rate.
 *  The original globals put walkSpeed at125, jumpSpeed at555 and fallSpeed at670 pixels per
 *  second, so any per-axis or per-direction rate below that leaves a jumping or falling peer
 *  -- which moves the drawn pose against one of the axis signs -- trailing by more than a
 *  hundred pixels. The correction is therefore directional in the vector sense only. */
const CORRECTION_PX_PER_MS = 1.2;
const MAX_SAMPLE_DT_MS = 100;
/** An error larger than the fastest publication of travel cannot be a reconstruction
 *  artifact: it is a relocation, and the destination is presented outright. */
const SNAP_PX = 96;

function clamp(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/** Distance travelled after `dt` ms of coasting: full speed for one publication interval,
 *  then an exponential run-down that is bounded by `COAST_TAU_MS`. */
export function remoteTravelMs(age) {
  if (!(age > 0)) return 0;
  if (age <= MAX_EXTRAP_MS) return age;
  const over = age - MAX_EXTRAP_MS;
  return MAX_EXTRAP_MS + COAST_TAU_MS * (1 - Math.exp(-over / COAST_TAU_MS));
}

function sampleEntry() {
  return {
    time: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    movementType: 0,
    foothold: null,
  };
}

/** OpenMS mob presentation policy: buffer snapshots, forecast briefly and ease error.
 * This is not the recovered native move-path replay. Remote characters use
 * RemotePlayerPath with explicit durations and no forecast (native-lag-handling.md). */
export class RemoteMotion {
  constructor(entity, tick, now) {
    this.x = entity.position.x;
    this.y = entity.position.y;
    this.tick = -Infinity;
    this.samples = Array.from({ length: SAMPLE_CAPACITY }, sampleEntry);
    this.head = 0;
    this.count = 0;
    this.playoutMs = BASE_PLAYOUT_MS;
    this.intervalMs = 0;
    this.jitterMs = 0;
    this.lastArrival = 0;
    this.lastSampleAt = 0;
    this.foothold = null;
    this.scratch = { x: 0, y: 0 };
    this.observe(entity, tick, now, null);
  }

  observe(entity, tick, now, foothold) {
    if (tick <= this.tick) return;
    const previous = this.entity;
    const reset =
      !previous ||
      previous.mobState?.generation !== entity.mobState?.generation ||
      previous.kind !== entity.kind;
    this.entity = entity;
    this.tick = tick;
    this.foothold = foothold;
    if (reset) {
      this.clearSamples();
      this.x = entity.position.x;
      this.y = entity.position.y;
      this.lastSampleAt = now;
    }
    this.measureArrival(now);
    this.push(entity, now, foothold);
    if (!reset) this.present(now);
  }

  /** A relocation is server-owned: hold its destination until a full movement state arrives. */
  relocate(x, y, now) {
    this.entity = {
      ...this.entity,
      position: { x, y },
      velocity: { x: 0, y: 0 },
    };
    this.x = x;
    this.y = y;
    this.clearSamples();
    this.lastSampleAt = now;
  }

  /** Draw the actor at `now - playoutMs`, then chase the buffered target at a bounded rate. */
  sample(now) {
    const target = this.evaluate(this.renderTime(now));
    const elapsed =
      this.lastSampleAt > 0 ? now - this.lastSampleAt : MAX_SAMPLE_DT_MS;
    this.lastSampleAt = now;
    const dt = clamp(elapsed, 0, MAX_SAMPLE_DT_MS);
    const errorX = target.x - this.x,
      errorY = target.y - this.y;
    const distance = Math.hypot(errorX, errorY);
    if (distance === 0) return this;
    const step =
      distance > SNAP_PX
        ? distance
        : Math.min(distance, CORRECTION_PX_PER_MS * dt);
    this.x += (errorX / distance) * step;
    this.y += (errorY / distance) * step;
    // Quantize the drawn pose to integer pixels after each sample.
    // Without this, the correction chase (CORRECTION_PX_PER_MS * dt) accumulates
    // sub-pixel float offsets that oscillate across Math.trunc() boundaries
    // in EntityAnimation.setPosition(), producing a 1px visible jitter on every
    // static mob. Rounding after each sample keeps the chase convergence smooth
    // without ever landing on a non-integer frame pixel.
    this.x = Math.round(this.x);
    this.y = Math.round(this.y);
    return this;
  }

  renderTime(now) {
    return now - this.playoutMs;
  }

  /** A jump the buffer cannot explain is a relocation: present it instead of sliding. */
  present(now) {
    const target = this.evaluate(this.renderTime(now));
    if (Math.hypot(this.x - target.x, this.y - target.y) > SNAP_PX) {
      this.x = target.x;
      this.y = target.y;
    }
  }

  /** Track the publication cadence and its jitter, then slew playout toward a target that
   *  covers roughly one and a half intervals plus twice the observed jitter. */
  measureArrival(now) {
    if (this.lastArrival > 0) {
      const interval = now - this.lastArrival;
      if (interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS) {
        if (this.intervalMs > 0) {
          this.jitterMs +=
            (Math.abs(interval - this.intervalMs) - this.jitterMs) * 0.25;
        }
        this.intervalMs =
          this.intervalMs > 0
            ? this.intervalMs + (interval - this.intervalMs) * 0.25
            : interval;
      }
    }
    this.lastArrival = now;
  }

  adaptPlayout(elapsed) {
    const interval = this.intervalMs > 0 ? this.intervalMs : BASE_PLAYOUT_MS;
    const target = clamp(
      interval * PLAYOUT_GAIN + this.jitterMs * JITTER_GAIN,
      MIN_PLAYOUT_MS,
      MAX_PLAYOUT_MS,
    );
    const maximum = (PLAYOUT_SLEW_MS_PER_SECOND * Math.max(0, elapsed)) / 1000;
    this.playoutMs += clamp(target - this.playoutMs, -maximum, maximum);
  }

  push(entity, now, foothold) {
    const entry = this.samples[(this.head + this.count) % SAMPLE_CAPACITY];
    if (this.count === SAMPLE_CAPACITY) {
      this.head = (this.head + 1) % SAMPLE_CAPACITY;
      this.count--;
    }
    entry.time = now;
    entry.x = entity.position.x;
    entry.y = entity.position.y;
    entry.vx = entity.velocity?.x ?? 0;
    entry.vy = entity.velocity?.y ?? 0;
    entry.movementType = entity.mobState?.movementType ?? 0;
    entry.foothold = foothold ?? null;
    this.count++;
  }

  clearSamples() {
    this.head = 0;
    this.count = 0;
    this.lastArrival = 0;
    this.intervalMs = 0;
    this.jitterMs = 0;
  }

  at(index) {
    return this.samples[(this.head + index) % SAMPLE_CAPACITY];
  }

  /** Position on the buffered timeline: interpolate inside the buffer, forecast the newest
   *  sample when the render time is past it, and hold the oldest before it. */
  evaluate(time) {
    if (this.count === 0) {
      this.scratch.x = this.x;
      this.scratch.y = this.y;
      return this.scratch;
    }
    const newest = this.at(this.count - 1);
    if (time >= newest.time) {
      this.forecast(newest, remoteTravelMs(time - newest.time));
      return this.scratch;
    }
    const oldest = this.at(0);
    if (time <= oldest.time) {
      this.scratch.x = oldest.x;
      this.scratch.y = oldest.y;
      return this.scratch;
    }
    for (let index = this.count - 2; index >= 0; index--) {
      const before = this.at(index),
        after = this.at(index + 1);
      if (time < before.time) continue;
      this.hermite(before, after, time);
      this.clampContact(before, after);
      return this.scratch;
    }
    this.scratch.x = newest.x;
    this.scratch.y = newest.y;
    return this.scratch;
  }

  /** A cubic Hermite between an airborne sample and the sample where the peer lands
   *  overshoots a couple of pixels through the platform. This OpenMS contact clamp never draws the peer below the surface it is
   *  arriving on, and never pulls back a peer that is leaving a contact. */
  clampContact(before, after) {
    const floor = after.foothold;
    if (!floor) return;
    if (before.foothold && before.foothold !== floor) return;
    if (floor.x1 === floor.x2) return;
    const x = this.scratch.x;
    if (x < Math.min(floor.x1, floor.x2) || x > Math.max(floor.x1, floor.x2)) {
      return;
    }
    const y =
      floor.y1 +
      ((x - floor.x1) * (floor.y2 - floor.y1)) / (floor.x2 - floor.x1);
    if (this.scratch.y > y) this.scratch.y = y;
  }

  /** Cubic Hermite between two publications, matching both positions and both velocities. */
  hermite(before, after, time) {
    const span = after.time - before.time;
    if (!(span > 0)) {
      this.scratch.x = after.x;
      this.scratch.y = after.y;
      return;
    }
    const t = (time - before.time) / span;
    const t2 = t * t,
      t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    this.scratch.x =
      h00 * before.x +
      h10 * span * (before.vx / 1000) +
      h01 * after.x +
      h11 * span * (after.vx / 1000);
    this.scratch.y =
      h00 * before.y +
      h10 * span * (before.vy / 1000) +
      h01 * after.y +
      h11 * span * (after.vy / 1000);
  }

  forecast(sample, travelMs) {
    const seconds = travelMs / 1000;
    const moving = this.entity?.mobState?.hp !== 0;
    let x = sample.x + (moving ? sample.vx * seconds : 0);
    let y = sample.y + (moving ? sample.vy * seconds : 0);
    const floor = sample.foothold ?? this.foothold;
    if (floor && floor.x1 !== floor.x2 && sample.movementType !== 3) {
      x = clamp(x, Math.min(floor.x1, floor.x2), Math.max(floor.x1, floor.x2));
      y =
        floor.y1 +
        ((x - floor.x1) * (floor.y2 - floor.y1)) / (floor.x2 - floor.x1);
    }
    this.scratch.x = x;
    this.scratch.y = y;
  }

  advance(elapsed) {
    this.adaptPlayout(elapsed);
  }
}
