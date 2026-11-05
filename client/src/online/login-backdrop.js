import { Container, Sprite, Texture } from "pixi.js";
import { loadVisualBundle } from "../rendering/visual-resources.js";
import { UISurface } from "../ui/ui-surface.js";
import { LoginScene } from "./login-scene.js";
import { loginPageOffset } from "./login-motion.js";
import { LoginCursor } from "./login-cursor.js";

const BUTTON_STATES = ["normal", "mouseOver", "pressed", "disabled"];
const MAX_SURFACES = 48;
const CHARACTER_ORIGINS = ["adventure", "knight", "aran"];

// Known extract-origin drift: some login artworks have the sprite visual anchor
// a few pixels below the manifest-computed origin. Nudge the whole panel (sprite
// bundle + DOM click rect together) so the authored MapleStory layout is
// preserved. Patch at runtime — extract will regenerate manifest on every run.
const PANEL_TOP_ADJUST = Object.freeze({
  "CharSelect/BtSelect": 2, // character-select "Enter Game" button drifts up 2px
});
// 005fc0e4: centerY=-8-600*stage. Explorer creation adds race substate1.
const STAGES = Object.freeze({
  account: { index: 0, centerY: -8 },
  characters: { index: 2, centerY: -1208 },
  create: { index: 4, centerY: -3008 },
});

/** Native MapLogin field plus original login controls; no substitute scenery. */
export class LoginBackdrop {
  constructor(login) {
    this.login = login;
    this.root = new Container({ label: "login-artwork" });
    this.surfaces = [];
    this.buttons = [];
    this.stages = new Map();
    this.controls = new Map([
      ["account", login.accountStage],
      ["characters", login.characterStage],
      ["create", login.createStage],
    ]);
    this.scene = new LoginScene(login.window);
    this.departingScene = new LoginScene(login.window);
    this.departingScene.host.hidden = true;
    this.departingCamera = { x: -400, y: -308 };
    this.camera = { x: -400, y: -308 };
    this.currentStage = null;
    this.transition = null;
    this.controller = new AbortController();
    this.ready = false;
    this.destroyed = false;
  }

  async prepare(signal) {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    const descriptor = this.login.catalog.ui?.bundles?.Login;
    if (!descriptor) {
      throw new Error("The original Login artwork bundle is missing");
    }
    this.resource = await loadVisualBundle(
      descriptor,
      this.login.services,
      combined,
    );
    if (this.destroyed) {
      this.resource.destroy();
      return;
    }
    this.basicResource = await loadVisualBundle(
      this.login.catalog.ui.bundles.Basic,
      this.login.services,
      combined,
    );
    if (this.destroyed) {
      this.basicResource.destroy();
      return;
    }
    await this.scene.prepare(this.login.catalog, this.login.services, combined);
    if (this.destroyed) return;
    await this.departingScene.prepare(
      this.login.catalog,
      this.login.services,
      combined,
    );
    if (this.destroyed) return;
    const cursor = await loadVisualBundle(
      this.login.catalog.ui.bundles.Cursor,
      this.login.services,
      combined,
    );
    if (this.destroyed) {
      cursor.destroy();
      return;
    }
    this.cursor = new LoginCursor(this.login, cursor);
    this.buildScreens();
    this.buildButtons();
    this.buildDialog();
    this.ready = true;
    this.login.host.dataset.artwork = "ready";
  }

  surface(host, name, size, resource = this.resource) {
    if (this.surfaces.length >= MAX_SURFACES) {
      throw new Error("Login artwork surface limit exceeded");
    }
    const panel = new UISurface(
      { app: this.login.app, host, root: this.root },
      name,
      resource,
      size,
    );
    panel.ownsResource = false;
    panel.element.className = "online-login-artwork";
    panel.element.setAttribute("aria-hidden", "true");
    panel.element.style.pointerEvents = "none";
    panel.element.style.left = "0";
    panel.element.style.top = "0";
    this.surfaces.push(panel);
    return panel;
  }

  buildFrame() {
    const panel = this.surface(this.login.window, "Login frame", [800, 600]);
    panel.element.style.zIndex = "1";
    panel.image("Common/frame", 0, 0);
  }

  stage(name) {
    const panel = this.surface(this.login.window, `Login ${name}`, [800, 600]);
    panel.element.style.zIndex = "2";
    panel.root.rasterClip = { x: 0, y: 0, width: 800, height: 600 };
    this.stages.set(name, panel);
    return panel;
  }

  buildScreens() {
    this.buildSelectionLight();
    this.buildFrame();
    this.stage("account");
    const characters = this.stage("characters");
    this.rosterArt = [];
    // 00603ff0: window(-290,-1218); 00606ba9: feet(170+125*i,80).
    for (let index = 0; index < this.login.rosterSlots.length; index++) {
      const x = 280 + index * 125;
      this.rosterArt.push({
        shadow: characters.stateImage("CharSelect/character/0/0", x, 370),
        empty: characters.stateImage("CharSelect/character/1/0", x, 370),
        origins: CHARACTER_ORIGINS.map((name) =>
          characters.stateImage(`CharSelect/${name}/0`, x, 370),
        ),
        tags: [
          this.buildNameTag(characters, 0),
          this.buildNameTag(characters, 1),
        ],
      });
    }
    this.buildCharacterInformation();
    this.buildCreationScreens();
    this.renderRoster();
    this.renderCreate();
  }

  /** 005f6482: two center-vector layers, z0xc00614a4, below the login windows.
   * effect/0 repeats (Animate0x20); effect/1 opens once (Animate0), then holds. */
  buildSelectionLight() {
    const panel = this.surface(
      this.login.window,
      "Login selection spotlight",
      [800, 600],
    );
    panel.element.style.zIndex = "0";
    panel.root.rasterClip = { x: 0, y: 0, width: 800, height: 600 };
    this.selectionLight = panel;
    this.selectionGleam = panel.stateImage("CharSelect/effect/0/0", 280, 0);
    this.selectionBeam = panel.stateImage("CharSelect/effect/1/0", 280, 0);
    this.selectionBeam.setAction("default", "once");
    this.lightCharacter = null;
  }

  renderSelectionLight() {
    const character = this.login.characters[this.login.selected];
    const visible =
      !this.controls.get("characters").hidden && Boolean(character);
    this.selectionLight.element.hidden = !visible;
    this.selectionLight.root.visible = visible;
    if (!character || character === this.lightCharacter) return;
    this.lightCharacter = character;
    // Map the native 125px slot spacing to the browser's composed-avatar feet.
    const x = 280 + 125 * (this.login.selected % 3);
    this.selectionGleam.setPosition(x, 0);
    this.selectionBeam.setPosition(x, 0);
    this.selectionGleam.setAction("default", "loop", true);
    this.selectionBeam.setAction("default", "once", true);
  }

  /** 0060292f z20 is above the selection controls (00603ff0 z10).
   * Keep the whole information window in its own DOM stacking context. */
  buildCharacterInformation() {
    const panel = this.surface(
      this.login.characterDetail,
      "Login character information",
      [183, 115],
    );
    panel.element.style.zIndex = "0";
    // 00603dbc: scroll local(-20,-25), fully opened frame3, origin(0,0).
    this.characterScroll = panel.image("CharSelect/scroll/0/3", -20, -25);
    // 00602b3b..00602b4f fills the 183×112 canvas with ARGB30ffff00
    // before copying charInfo; the gaps in the WZ image are not empty.
    this.characterInfoBackground = this.infoBackground(panel);
    panel.root.addChild(this.characterInfoBackground);
    this.characterInfo = panel.image("CharSelect/charInfo", 0, 0);
  }

  buildCreationScreens() {
    const create = this.stage("create");
    this.createSettings = create.image("NewChar/charSet", 509, 95);
    this.createName = create.image("NewChar/charName", 509, 95);
    this.createRows = [];
    for (let index = 0; index < 9; index++) {
      this.createRows.push(
        create.image(
          `NewChar/avatarSel/${index}/normal`,
          520,
          200 + 18 * index,
        ),
      );
    }
    // Retained legacy artwork; browser placement documented separately from v83.
    this.statsScroll = create.image("NewChar/scroll/0/3", 493, 150);
    this.statsTable = create.image("NewChar/statTb", 526, 205);
    this.diceFrames = [];
    for (let frame = 0; frame < 4; frame++) {
      this.diceFrames.push(
        create.stateImage(`NewChar/dice/${frame}`, 634, 211),
      );
    }
  }

  /** A bitmap sprite also participates in the bounded DOM artwork compositor. */
  infoBackground(panel) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Login information backing requires Canvas2D");
    }
    context.fillStyle = "#ffff00";
    context.fillRect(0, 0, 1, 1);
    const texture = Texture.from(canvas);
    const sprite = new Sprite({
      texture,
      width: 183,
      height: 112,
      alpha: 0x30 / 255,
    });
    panel.cleanups.push(() => texture.destroy(true));
    return sprite;
  }

  /** 00605b52 tiles the nine-pixel middle, then overlays the two original caps. */
  buildNameTag(panel, state) {
    const root = new Container();
    panel.root.addChild(root);
    const middle = [];
    for (let index = 0; index < 24; index++) {
      const image = panel.image(`CharSelect/nameTag/${state}/1`, index * 9, 0);
      root.addChild(image.container);
      middle.push(image);
    }
    const left = panel.image(`CharSelect/nameTag/${state}/0`, 0, 0);
    const right = panel.image(`CharSelect/nameTag/${state}/2`, 0, 0);
    root.addChild(left.container, right.container);
    return { root, middle, right };
  }

  positionNameTags(index) {
    const slot = this.login.rosterSlots[index];
    const textWidth = slot.name.clientWidth;
    const width = Math.min(216, textWidth < 41 ? 58 : textWidth + 18);
    const left = 286 + index * 125 - Math.trunc(width / 2);
    // 00605e95..00605eab: x=trunc((canvasWidth-textWidth)/2)-1, y=2.
    // The DOM text and raster tag must share that integer origin, including odd widths.
    slot.name.style.left = `${left - (230 + index * 125) + Math.trunc((width - textWidth) / 2) - 1}px`;
    const selected = slot.index === this.login.selected;
    for (let state = 0; state < 2; state++) {
      const tag = this.rosterArt[index].tags[state];
      tag.root.visible = Boolean(slot.character) && state === Number(selected);
      tag.root.position.set(left, 370);
      // Native composition is bounded by the width×22 nameplate canvas.
      tag.root.rasterClip = { x: 0, y: 0, width, height: 22 };
      tag.right.setPosition(width - 10, 0);
      for (let tile = 0; tile < tag.middle.length; tile++) {
        tag.middle[tile].container.visible = tile * 9 < width - 10;
      }
    }
  }
  renderRoster() {
    if (!this.rosterArt) return;
    this.renderSelectionLight();
    this.characterInfo.container.visible = this.login.characters.length > 0;
    this.characterScroll.container.visible =
      this.characterInfo.container.visible;
    this.characterInfoBackground.visible = this.characterInfo.container.visible;
    this.login.characterDetail.hidden = !this.login.characters.length;
    const x = 180 + 130 * (this.login.selected % 3);
    this.login.characterDetail.style.left = `${x}px`;
    for (let index = 0; index < this.rosterArt.length; index++) {
      const character = this.login.rosterSlots[index].character;
      const occupied = Boolean(character);
      this.rosterArt[index].shadow.container.visible = !occupied;
      this.rosterArt[index].empty.container.visible = !occupied;
      // 006072b7..00607348 selects the original class sign behind each avatar.
      const job = character?.job ?? 0;
      const origin =
        Math.trunc(job / 1000) === 1
          ? 1
          : Math.trunc(job / 100) === 21 || job === 2000
            ? 2
            : 0;
      for (let family = 0; family < CHARACTER_ORIGINS.length; family++) {
        this.rosterArt[index].origins[family].container.visible =
          occupied && family === origin;
      }
      this.positionNameTags(index);
    }
  }

  renderCreate() {
    if (!this.createSettings) return;
    const naming = this.login.creationPhase === "name";
    const appearance = this.login.creationPhase === "appearance";
    const stats = this.login.creationPhase === "stats";
    this.createSettings.container.visible = appearance;
    this.createName.container.visible = naming;
    for (const row of this.createRows) row.container.visible = appearance;
    this.statsScroll.container.visible = this.statsTable.container.visible =
      stats;
    this.renderDice();
  }

  renderDice() {
    if (!this.diceFrames) return;
    // WZ dice frames carry no delay. 80ms/frame is a browser presentation policy.
    const active = this.login.rollingStats || this.login.creationRoll;
    const frame =
      active && this.login.diceElapsedMs < 320
        ? 1 + (Math.floor(this.login.diceElapsedMs / 80) % 3)
        : 0;
    for (let index = 0; index < this.diceFrames.length; index++) {
      this.diceFrames[index].container.visible =
        this.login.creationPhase === "stats" && index === frame;
    }
  }

  buildButtons() {
    const login = this.login;
    const bindings = [
      [login.submitButton, "Title/BtLogin"],
      [login.signUpTab, "Title/BtNew"],
      [login.enterButton, "CharSelect/BtSelect"],
      [login.createButton, "CharSelect/BtNew"],
      [login.deleteButton, "CharSelect/BtDelete"],
      [login.backButton, "NewChar/BtNo"],
      [login.submitCreate, "NewChar/BtYes"],
    ];
    for (const [button, path] of bindings) this.skin(button, path);
    this.skinPage(login.previous, "CharSelect/pageL");
    this.skinPage(login.next, "CharSelect/pageR");
    for (const row of Object.values(login.optionRows)) {
      this.skin(row.previous, "NewChar/BtLeft");
      this.skin(row.next, "NewChar/BtRight");
    }
    for (const { button, path } of login.accountButtons) {
      this.skin(button, path);
    }
  }

  skin(button, path, resource = this.resource) {
    const normal = resource.manifest.metadata.assets[`${path}/normal/0`];
    if (!normal) throw new Error(`Missing login control ${path}`);
    const panel = this.surface(
      button,
      path,
      [normal.width, normal.height],
      resource,
    );
    const adjust = PANEL_TOP_ADJUST[path];
    if (adjust) panel.element.style.top = `${adjust}px`;
    const entry = {
      button,
      panel,
      states: {},
      hover: false,
      pressed: false,
    };
    button.classList.add("online-login-skinned");
    button.style.width = `${Math.max(parseFloat(button.style.width) || 0, normal.width)}px`;
    button.style.height = `${Math.max(parseFloat(button.style.height) || 0, normal.height)}px`;
    button.title = button.getAttribute("aria-label") ?? button.textContent;
    for (const state of BUTTON_STATES) {
      const source = `${path}/${state}/0`;
      if (panel.assets[source]) {
        entry.states[state] = panel.stateImage(
          source,
          normal.origin.x,
          normal.origin.y,
        );
      }
    }
    this.bindButtonInput(entry);
    this.buttons.push(entry);
    this.paintButton(entry);
    return entry;
  }

  /** Page arrows are two authored image states, not NewChar's small row arrows. */
  skinPage(button, path) {
    const normal = this.resource.manifest.metadata.assets[`${path}/0/0`];
    const panel = this.surface(button, path, [normal.width, normal.height]);
    const entry = { button, panel, states: {}, hover: false, pressed: false };
    button.classList.add("online-login-skinned");
    button.style.width = `${normal.width}px`;
    button.style.height = `${normal.height}px`;
    entry.states.normal = panel.stateImage(
      `${path}/0/0`,
      normal.origin.x,
      normal.origin.y,
    );
    entry.states.mouseOver = panel.stateImage(
      `${path}/1/0`,
      normal.origin.x,
      normal.origin.y,
    );
    this.bindButtonInput(entry);
    this.buttons.push(entry);
  }

  bindButtonInput(entry) {
    const { button } = entry;
    const options = { signal: this.controller.signal };
    button.addEventListener(
      "pointerenter",
      () => {
        entry.hover = true;
      },
      options,
    );
    button.addEventListener(
      "pointerleave",
      () => {
        entry.hover = false;
        entry.pressed = false;
      },
      options,
    );
    button.addEventListener(
      "pointerdown",
      () => {
        entry.pressed = true;
      },
      options,
    );
    button.addEventListener(
      "pointerup",
      () => {
        entry.pressed = false;
      },
      options,
    );
    button.addEventListener(
      "blur",
      () => {
        entry.pressed = false;
      },
      options,
    );
    button.addEventListener(
      "keydown",
      (event) => {
        if (event.key === " " || event.key === "Enter") entry.pressed = true;
      },
      options,
    );
    button.addEventListener(
      "keyup",
      () => {
        entry.pressed = false;
      },
      options,
    );
  }

  buildDialog() {
    const dialog = this.login.dialogs;
    const panel = this.surface(dialog.window, "Login message", [362, 219]);
    panel.image("Notice/backgrnd/2", 0, 0);
    this.skin(dialog.confirmButton, "BtOK2", this.basicResource);
    this.skin(dialog.cancelButton, "BtCancel2", this.basicResource);
  }

  paintButton(entry) {
    const state = entry.button.disabled
      ? "disabled"
      : entry.pressed
        ? "pressed"
        : entry.hover
          ? "mouseOver"
          : "normal";
    const visible = entry.states[state] ?? entry.states.normal;
    for (const name of BUTTON_STATES) {
      const sprite = entry.states[name];
      if (sprite) sprite.container.visible = sprite === visible;
    }
  }

  showStage(name) {
    if (!this.ready) return;
    const next = STAGES[name];
    if (!next) throw new Error(`Unknown native login stage ${name}`);
    if (this.currentStage && this.currentStage !== name) {
      this.transition = {
        from: this.currentStage,
        to: name,
        fromY: this.camera.y,
        toY: next.centerY - 300,
        durationMs: 800,
        elapsedMs: 0,
      };
      this.departingCamera.y = this.camera.y;
      this.departingScene.update(
        this.departingCamera,
        this.scene.elapsedMs - this.departingScene.elapsedMs,
      );
    }
    this.camera.y = next.centerY - 300;
    this.currentStage = name;
    // Paint the destination before exposing its translated DOM plane.
    this.scene.update(this.camera, 0);
    this.positionStage();
  }

  replayTransition() {
    if (!this.transition) return;
    this.transition.elapsedMs = 0;
    this.positionStage();
  }

  positionStage() {
    const transition = this.transition;
    const active = transition && transition.elapsedMs < transition.durationMs;
    const offset = active
      ? loginPageOffset(
          transition.fromY,
          transition.toY,
          transition.elapsedMs,
          transition.durationMs,
        )
      : 0;
    const transform = `translateY(${Math.trunc(offset)}px)`;
    this.scene.host.style.transform = transform;
    this.departingScene.host.hidden = !active;
    const distance = active
      ? Math.sign(transition.toY - transition.fromY) * 600
      : 0;
    if (active) {
      this.departingScene.host.style.transform = `translateY(${Math.trunc(offset - distance)}px)`;
    }
    for (const [name, panel] of this.stages) {
      const departing = active && name === transition.from;
      const visible = name === this.currentStage || departing;
      const placement = departing
        ? this.departingScene.host.style.transform
        : transform;
      panel.element.hidden = !visible;
      panel.root.visible = visible;
      panel.element.style.transform = placement;
      const controls = this.controls.get(name);
      controls.hidden = !visible;
      controls.style.transform = placement;
      if (name === "characters") {
        this.selectionLight.element.style.transform = placement;
      }
    }
    this.renderSelectionLight();
    this.login.window.querySelector(".online-login-body").inert =
      Boolean(active);
  }

  advanceTransition(ms) {
    const transition = this.transition;
    if (!transition || transition.elapsedMs >= transition.durationMs) return;
    transition.elapsedMs = Math.min(
      transition.durationMs,
      transition.elapsedMs + ms,
    );
    this.positionStage();
    if (transition.elapsedMs === transition.durationMs) this.login.focusStage();
  }

  snapshot() {
    const transition = this.transition;
    return {
      ...this.scene.snapshot(),
      cursor: this.cursor?.snapshot() ?? null,
      spotlight: this.spotlightSnapshot(),
      transition: {
        from: transition?.from ?? null,
        to: transition?.to ?? this.currentStage,
        elapsedMs: Math.trunc(transition?.elapsedMs ?? 0),
        durationMs: transition?.durationMs ?? 0,
        active: Boolean(
          transition && transition.elapsedMs < transition.durationMs,
        ),
        replayable: Boolean(transition),
      },
    };
  }

  spotlightSnapshot() {
    if (!this.selectionLight) return null;
    return {
      visible: this.selectionLight.root.visible,
      beam: this.selectionBeam.snapshot(),
      gleam: this.selectionGleam.snapshot(),
    };
  }

  update(ms) {
    if (!this.ready || this.destroyed) return;
    this.advanceTransition(ms);
    this.scene.update(this.camera, ms);
    if (!this.departingScene.host.hidden) {
      this.departingScene.update(
        this.departingCamera,
        this.scene.elapsedMs - this.departingScene.elapsedMs,
      );
    }
    this.renderDice();
    for (const entry of this.buttons) this.paintButton(entry);
    for (const panel of this.surfaces) panel.update(ms);
    this.cursor?.update(ms);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.abort();
    this.cursor?.destroy();
    this.scene.destroy();
    this.departingScene.destroy();
    for (const panel of this.surfaces) panel.destroy();
    this.resource?.destroy();
    this.basicResource?.destroy();
    this.root.destroy({ children: true });
    this.surfaces.length = 0;
    this.buttons.length = 0;
    this.stages.clear();
  }
}
