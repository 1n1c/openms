/** Compile original frame clocks and geometry without allocating renderer resources.
 *  NOTE: Per-frame bottom alignment is NOT done here — textures may not be fully loaded
 *  at compile time, so texture.height is unreliable. Alignment happens at runtime in
 *  EntityAnimation.advance() when we have the actual loaded sprite heights. */
export function compileAction(frames, textures) {
  let duration = 0;
  let preActionMs = 0;
  let hasPreAction = false;
  let alias = false;
  const ends = new Float64Array(frames.length);
  const parts = frames.map((frame, index) => {
    duration += frame.delay;
    if (frame.preAction) preActionMs += frame.delay;
    hasPreAction ||= Boolean(frame.preAction);
    alias ||= Boolean(frame.alias);
    ends[index] = duration;
    return frame.parts.slice().sort((a, b) => a.z - b.z);
  });
  const geometry = frames.map((frame, index) =>
    frameGeometry(frame, parts[index], textures),
  );
  const release = alias ? preActionMs : duration - frames.at(-1).delay;
  const repeat = frames[0].repeat ?? 0;
  const repeatStartMs = repeat > 0 ? ends[repeat - 1] : 0;
  return {
    ends,
    parts,
    duration,
    repeat,
    repeatStartMs,
    repeatDurationMs: duration - repeatStartMs,
    frames,
    geometry,
    release,
    preActionMs,
    hasPreAction,
  };
}

/** 006431e3/Gr2D5040b9e7 repeat the authored suffix, not an intro or loop count. */
export function loopTime(action, ms) {
  if (ms < action.duration) return ms;
  if (action.repeatDurationMs === 0) return action.duration;
  return (
    action.repeatStartMs +
    ((ms - action.repeatStartMs) % action.repeatDurationMs)
  );
}

/** Bounded original binary lookup preserves duplicate/zero-delay frame boundaries. */
export function timedFrame(action, time) {
  let low = 0;
  let high = action.ends.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (time < action.ends[middle]) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Logical geometry retains original canvas periods across atlas tiles. */
function frameGeometry(frame, parts, textures) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const part of parts) {
    const texture = textures.get(part.texture);
    left = Math.min(left, part.x);
    top = Math.min(top, part.y);
    right = Math.max(right, part.x + texture.width);
    bottom = Math.max(bottom, part.y + texture.height);
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    periodWidth: frame.sourceSize?.width ?? right - left,
    periodHeight: frame.sourceSize?.height ?? bottom - top,
  };
}

/** Resolve authored weapon action families without changing other pose actions. */
export function avatarAction(actor, action) {
  if (action === "stand1" || action === "stand2") {
    action = actor.avatar?.standAction ?? action;
  }
  if (action === "walk1" || action === "walk2") {
    action = actor.avatar?.walkAction ?? action;
  }
  return action;
}

/** Shared authored clock: holding a climb consumes its delay but cannot select the next frame. */
export function advanceActionClock(clock, ms) {
  if (
    !Number.isFinite(ms) ||
    ms < 0 ||
    !Number.isFinite(clock.elapsedMs + ms)
  ) {
    throw new Error("Invalid animation elapsed milliseconds");
  }
  clock.elapsedMs += ms;
  const current = clock.current;
  if (current.duration === 0 || clock.completed) return false;
  if (clock.holdFrame) {
    clock.actionTimeMs = Math.min(
      current.ends[clock.frame],
      clock.actionTimeMs + ms,
    );
    return false;
  }
  if (clock.playback === "once") {
    clock.actionTimeMs = Math.min(current.duration, clock.actionTimeMs + ms);
    clock.completed = clock.actionTimeMs === current.duration;
  } else {
    clock.actionTimeMs = loopTime(current, clock.actionTimeMs + ms);
  }
  return true;
}

/** Seeking is independent of expression lifetime and resumes a completed one-shot. */
export function seekActionClock(clock, ms) {
  if (!Number.isFinite(ms) || ms < 0)
    {throw new Error("Invalid animation seek milliseconds");}
  const duration = clock.current.duration;
  clock.elapsedMs = ms;
  clock.completed = clock.playback === "once" && ms >= duration;
  clock.actionTimeMs =
    duration === 0
      ? 0
      : clock.playback === "once"
        ? Math.min(ms, duration)
        : loopTime(clock.current, ms);
}
