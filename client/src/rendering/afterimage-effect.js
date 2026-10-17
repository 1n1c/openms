import { Container, Sprite } from "pixi.js";

/** Transient melee afterimage — a single authored canvas frame that fades out and self-destructs.
 *  Mirrors GM MapleCharacter afterimage spawning: per-spawnFrame particle with fixed delay.
 *
 *  Positioning: afterimage parts are authored in facing-right coordinates relative to the actor origin.
 *  The effect container lives INSIDE the actor's container, whose scale.x already mirrors for facing-left.
 *  So we NEVER manually flip — parent scale.x handles facing automatically.
 */
export class AfterimageEffect {
  /**
   * @param {import('pixi.js').Container} owner  Parent container (actor rendering).
   * @param {{ delay: number, parts: [{ texture: string, x: number, y: number, opacity: number, z?: number }], alphaEnd: number }} frame
   * @param {Map<string, import('pixi.js').Texture>} textures  Atlas textures.
   * @param {{ anchorX: number, anchorY: number, flip?: boolean, z?: number }} options
   */
  constructor(owner, frame, textures, options) {
    this.owner = owner;
    this.frame = frame;
    this.textures = textures;
    this.anchorX = options.anchorX ?? 0;
    this.anchorY = options.anchorY ?? 0;
    // Note: flip is intentionally ignored — parent actor.container.scale.x handles facing.
    this.z = options.z ?? 0;
    this.destroyed = false;

    // Create sprites — one per part.
    const n = frame.parts.length;
    this.container = new Container({ label: "afterimage" });
    if (this.z < 0) owner.addChildAt(this.container, 0);
    else owner.addChild(this.container);

    this.sprites = new Array(n);
    for (let i = 0; i < n; i++) {
      const part = frame.parts[i];
      const sprite = new Sprite();
      const texture = textures.get(part.texture);
      if (!texture) {
        sprite.visible = false;
      } else {
        sprite.texture = texture;
        // Position relative to actor origin. Parent scale.x mirrors for facing-left.
        sprite.position.set(part.x, part.y);
        sprite.scale.set(1, 1);
        if (part.z !== undefined) sprite.zIndex = part.z;
        sprite.alpha = part.opacity ?? 1;
      }
      this.container.addChild(sprite);
      this.sprites[i] = sprite;
    }

    // Container initial position at anchor.
    this.container.position.set(this.anchorX, this.anchorY);

    // Drive with elapsed time — alpha linearly decays from startOpacity → alphaEnd over delay.
    this.elapsedMs = 0;
    this.delay = frame.delay ?? 200;
    this.startOpacity = frame.parts[0]?.opacity ?? 1;
    this.alphaEnd = frame.alphaEnd ?? 0;
  }

  /** Advance the afterimage clock. Returns true when playback completes. */
  advance(ms) {
    if (this.destroyed) return true;
    this.elapsedMs += ms;
    if (this.elapsedMs >= this.delay) {
      this.destroy();
      return true;
    }
    // Linear alpha decay across all sprites.
    const t = this.delay > 0 ? this.elapsedMs / this.delay : 1;
    const alpha = this.startOpacity + (this.alphaEnd - this.startOpacity) * t;
    for (const sprite of this.sprites) {
      if (sprite.visible) sprite.alpha = Math.max(0, Math.min(1, alpha));
    }
    return false;
  }

  /** Sync position to the actor's current anchor point. */
  sync(anchorX, anchorY) {
    this.anchorX = anchorX;
    this.anchorY = anchorY;
    this.container.position.set(anchorX, anchorY);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    for (const sprite of this.sprites) {
      sprite.destroy();
    }
    this.container.destroy();
  }
}
