import { Container, Sprite } from "pixi.js";

/** Transient melee afterimage — plays a sequence of authored canvas frames
 *  (bright → dim, matching MapleStory AfterImage.cs).
 *
 *  One particle spawned per attack. Each sequence entry is one spawnFrame's
 *  Canvas node (delay + a1 alpha decay). Playback: frame 0 plays for its
 *  delay ms, fades from 1.0 → alphaEnd; then frame 1 starts, etc. When all
 *  frames done, self-destruct.
 *
 *  Positioning: afterimage parts are authored in facing-right coordinates
 *  relative to the actor origin. The effect container lives INSIDE the
 *  actor's container whose scale.x mirrors for facing-left — we NEVER
 *  manually flip.
 */
export class AfterimageEffect {
  /**
   * @param {import('pixi.js').Container} owner  Parent container (actor rendering).
   * @param {Array<{ delay: number, alphaEnd: number, parts: [{ texture: string, x: number, y: number, opacity: number, z?: number }] }>} sequence
   * @param {Map<string, import('pixi.js').Texture>} textures  Atlas textures.
   * @param {{ anchorX: number, anchorY: number, z?: number }} options
   */
  constructor(owner, sequence, textures, options) {
    this.owner = owner;
    this.textures = textures;
    this.anchorX = options.anchorX ?? 0;
    this.anchorY = options.anchorY ?? 0;
    this.z = options.z ?? 0;
    this.destroyed = false;

    this.container = new Container({ label: "afterimage" });
    if (this.z < 0) owner.addChildAt(this.container, 0);
    else owner.addChild(this.container);

    // Build one sprite per sequence entry — only current frame visible.
    this.sequence = sequence;
    this.currentIndex = 0;
    this.elapsedInFrame = 0;

    // Flatten all sprites across all sequence frames. Each sequence entry
    // can have multiple parts (typically just 1 for melee afterimage).
    this.spriteFrames = []; // [{ sprites: [...], frameDelay, startOpacity, alphaEnd }]
    for (const entry of sequence) {
      const frameSprites = [];
      for (const part of entry.parts) {
        const sprite = new Sprite();
        const texture = textures.get(part.texture);
        if (!texture) {
          sprite.visible = false;
        } else {
          sprite.texture = texture;
          sprite.position.set(part.x, part.y);
          sprite.scale.set(1, 1);
          if (part.z !== undefined) sprite.zIndex = part.z;
          sprite.alpha = part.opacity ?? 1;
          sprite.visible = false; // All hidden initially; we reveal frame by frame.
        }
        this.container.addChild(sprite);
        frameSprites.push(sprite);
      }
      this.spriteFrames.push({
        sprites: frameSprites,
        frameDelay: entry.delay ?? 120,
        startOpacity: entry.parts[0]?.opacity ?? 1,
        alphaEnd: entry.alphaEnd ?? 0,
      });
    }

    // Reveal first frame.
    if (this.spriteFrames[0]) {
      for (const s of this.spriteFrames[0].sprites) s.visible = true;
    }

    this.container.position.set(this.anchorX, this.anchorY);
  }

  /** Advance playback clock. Returns true when complete. */
  advance(ms) {
    if (this.destroyed) return true;
    this.elapsedInFrame += ms;

    const current = this.spriteFrames[this.currentIndex];
    if (!current) {
      this.destroy();
      return true;
    }

    // Frame-switch check — move to next sequence entry.
    if (this.elapsedInFrame >= current.frameDelay) {
      // Hide current frame's sprites.
      for (const s of current.sprites) s.visible = false;

      this.currentIndex++;
      this.elapsedInFrame = 0;

      if (this.currentIndex >= this.spriteFrames.length) {
        this.destroy();
        return true;
      }

      // Show next frame's sprites.
      const next = this.spriteFrames[this.currentIndex];
      for (const s of next.sprites) s.visible = true;
    }

    // In-frame alpha decay — bright → dim within this frame's duration.
    const active = this.spriteFrames[this.currentIndex];
    const t = active.frameDelay > 0 ? this.elapsedInFrame / active.frameDelay : 1;
    const alpha = active.startOpacity + (active.alphaEnd - active.startOpacity) * t;
    for (const s of active.sprites) {
      if (s.visible) s.alpha = Math.max(0, Math.min(1, alpha));
    }

    return false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    for (const frame of this.spriteFrames) {
      for (const s of frame.sprites) {
        s.destroy();
      }
    }
    this.container.destroy();
  }
}
