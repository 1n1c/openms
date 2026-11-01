import { Container } from "pixi.js";
import { loadVisualBundle } from "../rendering/visual-resources.js";
import { UISurface } from "./ui-surface.js";
import { layoutHud, layoutWindow } from "./ui-layout.js";
import { replaceMinimap, updateProfilePanel } from "./ui-inspection.js";
import { updateProfileHud, finishGaugeWarnings } from "./ui-hud.js";
import { updateMinimap, cycleMinimap } from "./ui-minimap.js";
import { UICursor } from "./ui-cursor.js";
import { UIChat } from "./ui-chat.js";
import {
  refreshKeys,
  cancelKeys,
  keyAtPoint,
  layoutKeyNotice,
  answerKeyNotice,
} from "./ui-keyconfig.js";
import {
  layoutQuickSlotConfig,
  closeQuickSlotConfig,
  captureQuickKey,
} from "./ui-quickslot-config.js";
import {
  toggleQuickSlots,
  refreshQuickSlots,
  quickKeyAtPoint,
} from "./ui-quickslots.js";
import { REVIVAL_POLICY } from "../character/revival.js";
import {
  renderTooltip,
  positionTooltip,
  itemTooltipSource,
  prepareItemTooltipSource,
} from "./ui-tooltip.js";
import { TemporaryStatView } from "./ui-temporary-stats.js";
import {
  bindingAction,
  isReleaseBinding,
  keyIndexForCode,
  KEY_COUNT,
} from "../input/keymap.js";
import { GameplayNoticeLog } from "./ui-gameplay-notices.js";
import {
  layoutMesoDialog,
  refreshMesoDialog,
  submitMesoDrop,
} from "./ui-meso-dialog.js";
import {
  LOCAL_WINDOW_NAMES,
  layoutLocalWindow,
  localWindowSize,
} from "./ui-local-windows.js";
import {
  layoutPrompt,
  promptBundleName,
  requestPrompt,
  settlePrompt,
  submitPrompt,
} from "./ui-prompt.js";
import {
  beginItemCarry,
  carriedInstance,
  dropCarriedItem,
  useInventoryItem,
} from "./ui-carry.js";
import { placeMacroSkill } from "./ui-skill-macros.js";
import { GameLogs, layoutGameLogs } from "./ui-game-logs.js";
import {
  loadWindowPositions,
  saveWindowPositions,
  loadWindowTabs,
  saveWindowTabs,
} from "./ui-window-positions.js";

const INVITATION_WINDOWS = new Set(["TradeInvitation", "SocialInvitation"]);
// These controllers borrow a field/NPC; character windows and their drafts do not.
const FIELD_WINDOWS = new Set([
  "ITC",
  "UtilDlgEx",
  "Shop",
  "Trunk",
  "MesoDrop",
  "Revive",
  "TradingRoom",
  "TradeInvitation",
]);
const MODAL_WINDOWS = new Set([
  "ITC",
  "UtilDlgEx",
  "Trunk",
  "NativePrompt",
  "QuickSlotConfig",
  "KeyConfigNotice",
  "Revive",
  "MesoDrop",
  "GameOpt",
  "SysOpt",
  "WorldMap",
]);
const WINDOWS = new Set([
  "Item",
  "Equip",
  "Stat",
  "Skill",
  "GameMenu",
  "ShortCut",
  "KeyConfig",
  "MiniMap",
  "UtilDlgEx",
  "NativePrompt",
  "Revive",
  "MesoDrop",
  "QuickSlotConfig",
  "KeyConfigNotice",
  "GameOpt",
  "Quest",
  "SysOpt",
  "GameLogs",
  ...LOCAL_WINDOW_NAMES,
]);
/** Normal command names exclude constructing internal modal windows without their owners. */
export const NORMAL_UI_NAMES = Object.freeze([
  ...Array.from(WINDOWS).filter(
    (name) => !MODAL_WINDOWS.has(name) && !INVITATION_WINDOWS.has(name),
  ),
  "GameOpt",
  "SysOpt",
  "WorldMap",
  "QuickSlot",
  "focusGame",
  "close",
  "confirm",
  "cancel",
  "chat",
]);
const SIZES = {
  MiniMap: [260, 216],
  UtilDlgEx: [529, 206],
  Quest: [245, 396],
  NativePrompt: [529, 206],
  QuickSlotConfig: [266, 238],
  KeyConfigNotice: [266, 116],
  Revive: [286, 146],
  MesoDrop: [266, 160],
  GameLogs: [266, 399],
  GameMenu: [93, 140],
  ShortCut: [93, 271],
};
// Native 00849e31..6a / 0084a5e2: fixed reference-plane popups above their HUD controls.
const POPUP_POSITIONS = {
  GameMenu: [666, 423],
  ShortCut: [707, 296],
  Revive: [257, 227],
};
const STYLE = `.maple-ui-root{position:absolute;pointer-events:none;transform-origin:0 0;z-index:5;font:11px Tahoma,Arial,sans-serif;color:#222;user-select:none}.maple-ui-root button{pointer-events:auto;cursor:pointer;font:11px Tahoma,Arial,sans-serif;min-height:0;min-width:0;box-sizing:border-box;margin:0;line-height:normal}.maple-ui-root .maple-ui-hit{padding:0;border:0;background:transparent;color:transparent;box-shadow:none;border-radius:0}.maple-ui-root .maple-ui-hit:focus-visible{outline:1px solid #ffc63d;outline-offset:1px}.maple-ui-root .maple-ui-local{padding:3px 5px;background:#263442;color:white;border:1px solid #a6bed0;border-radius:2px;white-space:nowrap}.maple-ui-root .maple-ui-text{white-space:pre-wrap;line-height:1.35;overflow-wrap:anywhere;pointer-events:none}.maple-ui-root .maple-ui-unavailable{background:rgba(255,255,240,.94);padding:4px;box-sizing:border-box;border:1px solid #c6ad75}.maple-ui-root .maple-ui-status{color:white;background:#273342;padding:3px}.maple-ui-root .maple-ui-dialog-text{color:#222}.maple-ui-root .maple-ui-tooltip{position:absolute;max-width:300px;background:#20252a;color:white;padding:6px;border:1px solid #a9b6c2;white-space:pre-wrap;z-index:100;pointer-events:none}.maple-ui-root .maple-ui-drag{position:absolute;left:0;top:0;height:20px;cursor:move;background:transparent;touch-action:none}`;
const LOCAL_STYLE = `.maple-ui-root *{-webkit-user-select:none;user-select:none}.maple-ui-root .maple-ui-content{white-space:pre-wrap;line-height:1.35;overflow-wrap:anywhere}.maple-ui-root .maple-ui-profile{font-size:11px}.maple-ui-root .maple-ui-content button{position:static;white-space:normal}.maple-ui-root select,.maple-ui-root input{pointer-events:auto;max-width:100%;box-sizing:border-box}.maple-ui-root input,.maple-ui-root textarea,.maple-ui-root [contenteditable]:not([contenteditable=false]),.maple-ui-root [contenteditable]:not([contenteditable=false]) *{-webkit-user-select:text;user-select:text}.maple-ui-root .maple-ui-status{box-sizing:border-box}.maple-ui-root .maple-ui-save-actions{display:flex;gap:8px;margin-top:8px}`;
const CURSOR_STYLE =
  ".maple-ui-root.maple-ui-original-cursor,.maple-ui-root.maple-ui-original-cursor *{cursor:none!important}.maple-ui-chat-log{position:absolute;overflow:hidden;font:12px Arial,sans-serif;line-height:13px;color:white;white-space:pre-wrap;pointer-events:none}";
const FOCUSABLE =
  "button:not([disabled]):not([hidden]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex='0']";

function editingTarget(target) {
  return Boolean(
    target?.isContentEditable || target?.matches?.("input,select,textarea"),
  );
}

/** Resolve retained window sizes or original background dimensions within the logical viewport. */
function windowSize(name, resource) {
  const asset = resource.manifest.metadata.assets?.[`${name}/backgrnd`];
  const size = SIZES[name] ||
    localWindowSize(name, resource) || [asset?.width, asset?.height];
  if (
    !size.every((value) => Number.isFinite(value) && value > 0) ||
    size[0] > 800 ||
    size[1] > 1200
  ) {
    throw new Error(`Invalid UI dimensions: ${name}`);
  }
  return [size[0], size[1]];
}

/** Screen-space UI owner. Browser window/focus policy is explicit, not a claim about original global arbitration. */
export class GameUI {
  constructor(app, services, hooks) {
    this.app = app;
    this.services = services;
    this.hooks = hooks;
    this.root = new Container({ label: "game-ui" });
    this.root.zIndex = 1000000;
    app.stage.addChild(this.root);
    this.host = document.createElement("div");
    this.host.className = "maple-ui-root";
    this.host.style.width = "800px";
    this.host.style.height = "600px";
    this.style = document.createElement("style");
    this.style.textContent = STYLE + LOCAL_STYLE + CURSOR_STYLE;
    this.host.append(this.style);
    app.canvas.parentElement.append(this.host);
    this.createTooltip();
    this.windows = new Map();
    // Validated browser preferences; independent of character-save transactions.
    this.windowPositions = new Map();
    this.windowTabs = new Map();
    this.positionsDirty = false;
    this.logs = new GameLogs(this);
    this.pending = new Map();
    this.windowPreloads = new Map();
    this.epoch = 0;
    this.prepareController = null;
    this.controller = new AbortController();
    this.scene = null;
    this.disposed = false;
    this.visible = true;
    this.drag = null;
    this.dialogNpc = null;
    this.store = null;
    this.quests = null;
    this.revivalPending = null;
    this.revivalOpenedAt = 0;
    this.revivalAutoConfirmed = false;
    this.layoutGeneration = 0;
    this.bindings = null;
    this.bindingDrag = null;
    this.bindingClickPointer = null;
    this.promptRequest = null;
    this.quickCapture = null;
    this.quickCaptureDraft = null;
    this.keyNotice = null;
    this.pointerPoint = { x: 0, y: 0 };
    this.layoutFrame = null;
    this.commandSignal = null;
    this.keyboardContext = false;
    this.releaseBindings = new Array(KEY_COUNT).fill(null);
    this.releaseGenerations = new Float64Array(KEY_COUNT);
    this.bounds = { left: 0, top: 0, right: 800, bottom: 600 };
    this.listenForInput();
    this.resize(app.screen.width, app.screen.height);
    this.observeLayout();
    this.restoreWindowPositions();
  }

  createTooltip() {
    this.tooltipController = null;
    this.tooltipResource = null;
    this.tooltip = document.createElement("div");
    this.tooltip.className = "maple-ui-tooltip";
    this.tooltip.hidden = true;
    this.tooltip.setAttribute("role", "tooltip");
    this.tooltip.id = "maple-context-tooltip";
    this.tooltip.style.cssText =
      "box-sizing:border-box;background:rgba(0,0,64,.62745);color:white;border:1px solid white;padding:8px;font:12px Arial,sans-serif;line-height:16px;overflow-wrap:anywhere;min-height:32px;";
    this.host.append(this.tooltip);
  }

  listenForInput() {
    this.keyHandler = this.onKey.bind(this);
    this.keyUpHandler = this.onKeyUp.bind(this);
    this.gameplayKeyHandler = this.routeGameplayKey.bind(this);
    this.pointerHandler = this.onPointer.bind(this);
    this.focusHandler = this.onFocus.bind(this);
    this.moveHandler = this.onDrag.bind(this);
    this.releaseHandler = this.endDrag.bind(this);
    this.bindingClickHandler = this.captureBindingClick.bind(this);
    this.bindingMouseHandler = this.onBindingMouseDown.bind(this);
    this.doubleClickHandler = this.onDoubleClick.bind(this);
    window.addEventListener("keydown", this.keyHandler, true);
    window.addEventListener("keyup", this.keyUpHandler, true);
    window.addEventListener("keydown", this.gameplayKeyHandler);
    window.addEventListener("pointerdown", this.pointerHandler, true);
    window.addEventListener("focusin", this.focusHandler, true);
    window.addEventListener("pointermove", this.moveHandler, true);
    window.addEventListener("pointerup", this.releaseHandler, true);
    window.addEventListener("pointercancel", this.releaseHandler, true);
    window.addEventListener("click", this.bindingClickHandler, true);
    window.addEventListener("dblclick", this.bindingClickHandler, true);
    window.addEventListener("dblclick", this.doubleClickHandler, true);
    window.addEventListener("contextmenu", this.bindingClickHandler, true);
    window.addEventListener("mousedown", this.bindingMouseHandler, true);
    window.addEventListener("blur", this.releaseHandler);
    this.captureLostHandler = this.onCaptureLost.bind(this);
    window.addEventListener(
      "lostpointercapture",
      this.captureLostHandler,
      true,
    );
    document.addEventListener("visibilitychange", this.releaseHandler);
  }

  validateIndex(index) {
    if (
      index?.schemaVersion !== 1 ||
      !index.bundles?.StatusBar ||
      !index.bundles.Basic ||
      !index.minimaps
    ) {
      throw new Error("Unsupported UI catalog");
    }
  }

  /** Prepare replacement HUD offscreen; old UI survives a failed or aborted catalog refresh. */
  async prepare(index, signal) {
    if (this.disposed) throw new Error("UI is destroyed");
    this.validateIndex(index);
    const combined = this.beginHudPreparation(signal);
    const controller = this.prepareController;
    let resource = null,
      cursorResource = null,
      panel = null,
      temporaryStats = null;
    try {
      resource = await loadVisualBundle(
        index.bundles.StatusBar,
        this.services,
        combined,
      );
      panel = new UISurface(this, "StatusBar", resource, [800, 600]);
      resource = null;
      await this.prepareCommonArtwork(panel, index, combined);
      cursorResource = await loadVisualBundle(
        index.bundles.Cursor,
        this.services,
        combined,
      );
      combined.throwIfAborted();
      if (this.hooks.isOperationPending?.()) {
        throw new Error("A native operation is pending");
      }
      temporaryStats = new TemporaryStatView(
        this,
        index.bundles.TemporaryStatView,
      );
      await temporaryStats.prepare(combined);
      combined.throwIfAborted();
      panel.position(0, 0);
      layoutHud(panel, index);
      combined.throwIfAborted();
      this.installHud(panel, index, cursorResource, temporaryStats);
      panel = null;
      resource = null;
      cursorResource = null;
      temporaryStats = null;
    } catch (error) {
      this.discardPreparedHud(panel, resource, cursorResource, temporaryStats);
      throw error;
    } finally {
      if (this.prepareController === controller) this.prepareController = null;
    }
  }

  /** The HUD owns common controls and tooltip art borrowed by child surfaces. */
  async prepareCommonArtwork(panel, index, signal) {
    for (const name of ["Basic", "ToolTip"]) {
      const resource = await loadVisualBundle(
        index.bundles[name],
        this.services,
        signal,
      );
      panel.dependencies.push(resource);
      if (name === "Basic") panel.basic = resource;
      panel.borrow(resource);
    }
  }

  beginHudPreparation(signal) {
    this.prepareController?.abort();
    const controller = new AbortController();
    this.prepareController = controller;
    return signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
  }

  discardPreparedHud(panel, resource, cursorResource, temporaryStats) {
    cursorResource?.destroy();
    temporaryStats?.destroy();
    if (panel) panel.destroy();
    else resource?.destroy();
  }

  installHud(panel, index, cursorResource, temporaryStats) {
    if (!this.closeAll()) {
      throw new Error("Close native sessions before replacing the HUD");
    }
    this.controller.abort();
    this.clearWindowPreloads();
    this.controller = new AbortController();
    this.epoch++;
    this.chat?.destroy();
    this.cursor?.destroy();
    this.temporaryStats?.destroy();
    this.notices?.destroy();
    this.logs.releaseNotification();
    this.hud?.destroy();
    this.hud = panel;
    this.index = index;
    this.temporaryStats = temporaryStats;
    this.cursor = new UICursor(this, cursorResource);
    this.chat = new UIChat(this, this.hud);
    this.notices = new GameplayNoticeLog(this);
    this.notices.resize(this.bounds);
    this.root.setChildIndex(this.hud.root, 0);
    this.refreshProfile();
    this.logs.presentAlert();
  }

  help(target) {
    const record = this.index?.help?.[target];
    return record ? `${record.title}\n${record.description}` : target;
  }

  mapName(id) {
    return this.hooks.mapName?.(id) ?? "Map name unavailable";
  }

  prompt(request) {
    return requestPrompt(this, request);
  }

  beginItemCarry(event, entry, visual) {
    return beginItemCarry(this, event, entry, visual);
  }

  sound(name) {
    this.hooks.playSound?.("UI", name);
  }

  /** Subscribe to durable authority; profile root may be null after an explicit load failure. */
  setProfile(store, quests) {
    if (!store || typeof store.subscribe !== "function") {
      throw new Error("UI requires a subscribable profile source");
    }
    this.unsubscribeProfile?.();
    this.endBindingDrag();
    this.epoch++;
    this.store = store;
    this.quests = quests;
    const jobs = quests?.knownJobs() || [];
    if (
      !Array.isArray(jobs) ||
      jobs.length > 1024 ||
      !jobs.every((id) => Number.isSafeInteger(id) && id >= 0)
    ) {
      throw new Error("Invalid retained quest job catalog");
    }
    this.knownJobs = jobs.slice();
    this.profileControls?.destroy();
    this.profileControls = this.hooks.createProfileControls?.(this) ?? null;
    this.hooks.inventoryItemPointerDown = (event, entry) => {
      const source = this.windows.get("Equip")?.iconLayer;
      return this.beginItemCarry(event, entry, {
        source,
        path: entry.template.iconPath,
      });
    };
    this.hooks.inventoryItemDoubleClick = (entry) =>
      useInventoryItem(this, entry);
    this.unsubscribeProfile = store.subscribe(() => this.refreshProfile());
    this.refreshProfile();
  }

  setBindings(service) {
    this.endBindingDrag();
    this.releaseBindings.fill(null);
    this.unsubscribeBindings?.();
    this.bindings = service;
    this.unsubscribeBindings = service.subscribe(() => {
      this.syncBindingCarry();
      refreshKeys(this.windows.get("KeyConfig"));
      refreshQuickSlots(this);
    });
    refreshKeys(this.windows.get("KeyConfig"));
    refreshQuickSlots(this);
  }

  status(message, { record = true } = {}) {
    this.lastStatus = String(message).slice(0, 1800);
    if (record && this.lastStatus) {
      this.chat?.receive({
        source: "local-system",
        text: this.lastStatus,
        time: this.hooks.now?.() ?? performance.now(),
      });
    }
    this.hooks.onStatus?.(this.lastStatus);
  }

  refreshProfile() {
    this.hideTooltip();
    if (this.disposed) return;
    if (this.hud?.gaugeWarnings && this.store?.profile) {
      this.hud.gaugeWarnings[0].setting = this.store.profile.settings.alerts.hp;
      this.hud.gaugeWarnings[1].setting = this.store.profile.settings.alerts.mp;
    }
    this.syncBindingCarry();
    this.profileControls?.refresh();
    updateProfileHud(this.hud, this.store);
    refreshQuickSlots(this);
    for (const panel of this.windows.values()) {
      this.refreshProfilePanel(panel);
      panel.dialogCleanup?.refresh?.();
    }
  }

  refreshProfilePanel(panel) {
    if (panel.name === "KeyConfig") refreshKeys(panel);
    else if (panel.name === "MesoDrop") refreshMesoDialog(panel);
    else if (panel.localRefresh) panel.localRefresh();
    else updateProfilePanel(panel, this.store);
  }

  /** Reopen the original prompt; the UI never grants HP or moves the avatar. */
  recoverProfile() {
    if (this.store?.profile?.hp !== 0 || !this.hooks.onRecover) return;
    try {
      const accepted = this.hooks.onRecover();
      this.status(
        accepted
          ? "Revival confirmation opened."
          : "Ordinary revival is unavailable.",
      );
    } catch (error) {
      this.report(error);
    }
  }

  async showRevival(scene) {
    if (scene !== this.scene || this.store.profile.hp !== 0) return;
    if (this.windows.has("Revive") || this.pending.has("Revive")) {
      return this.open("Revive", null);
    }
    this.close("UtilDlgEx", true);
    this.close("QuickSlotConfig");
    this.revivalOpenedAt = this.hooks.now?.() ?? performance.now();
    this.revivalAutoConfirmed = false;
    return this.open("Revive", null);
  }

  confirmRevival() {
    const panel = this.windows.get("Revive");
    if (this.store.profileTransactionPending || this.hooks.isFieldBlocked?.()) {
      return false;
    }
    if (
      !panel ||
      this.modal() !== panel ||
      this.revivalPending ||
      this.store.profile.hp !== 0
    ) {
      return false;
    }
    this.revivalPending = panel;
    panel.reviveControl.setDisabled(true);
    this.finishRevival(panel);
    return true;
  }

  async finishRevival(panel) {
    try {
      await this.hooks.onRevive();
      if (this.windows.get("Revive") === panel) this.close("Revive", true);
    } catch (error) {
      if (this.windows.get("Revive") === panel && error.name !== "AbortError") {
        this.status(`Revival unavailable: ${error.message}`);
        this.report(error);
      }
    } finally {
      if (this.revivalPending === panel) this.revivalPending = null;
      if (this.windows.get("Revive") === panel) {
        panel.reviveControl.setDisabled(false);
      }
    }
  }

  ownsProfile(store, epoch) {
    return (
      this.store === store &&
      this.epoch === epoch &&
      !this.controller.signal.aborted
    );
  }

  advanceMinimap() {
    const panel = this.windows.get("MiniMap");
    if (panel) return cycleMinimap(panel);
    if (this.pending.has("MiniMap")) return false;
    this.open("MiniMap").catch((error) => this.report(error));
    return true;
  }

  activate(name) {
    if (name === "GameLogs") return this.toggleWindow("GameLogs");
    return this.hooks.onAction(name);
  }

  /** Semantic routing belongs to InGameSystems; this method only toggles a window. */
  toggleWindow(name) {
    const modal = this.modal()?.name ?? this.pendingModal();
    if (modal && modal !== name) return false;
    if (name === "QuickSlot") return this.toggleQuickSlot();
    if (!WINDOWS.has(name)) return false;
    if (this.windows.has(name) || this.pending.has(name)) {
      if (!this.canCloseWindow(name, false)) return false;
      this.close(name);
    } else this.open(name).catch((error) => this.report(error));
    return true;
  }

  toggleQuickSlot() {
    if (!this.hud || !this.bindings || this.quickLoading) return false;
    toggleQuickSlots(this).catch((error) => this.report(error));
    return true;
  }

  admitWindow(name) {
    if (!WINDOWS.has(name) || !this.index) {
      throw new Error(`Unsupported UI window ${name}`);
    }
    const unavailable = this.hooks.windowCapability?.(name);
    if (unavailable) throw new Error(unavailable);
    if (name === "ITC" && !this.hooks.market) {
      throw new Error("The trading system requires an online character.");
    }
  }

  /** Demand-load one window; repeated requests coalesce and closed/cancelled loads never resurrect it. */
  async open(name, commandSignal = this.commandSignal) {
    this.admitWindow(name);
    const existing = this.windows.get(name);
    if (existing) {
      this.front(existing);
      return existing;
    }
    if (this.pending.has(name)) return this.pending.get(name).promise;
    if (name === "SkillMacro" && !this.windows.has("Skill")) {
      throw new Error("Skill macros require the Skill window.");
    }
    this.prepareModalOpen(name);
    const controller = new AbortController();
    const signals = [controller.signal, this.controller.signal];
    if (commandSignal) signals.push(commandSignal);
    const signal = AbortSignal.any(signals);
    const task = { controller, promise: null };
    task.promise = this.loadWindow(name, signal).finally(() => {
      if (this.pending.get(name) === task) this.pending.delete(name);
      if (!this.disposed) this.syncModalState();
    });
    this.pending.set(name, task);
    if (MODAL_WINDOWS.has(name)) this.hooks.clearInput();
    this.syncModalState();
    return task.promise;
  }

  prepareModalOpen(name) {
    if (MODAL_WINDOWS.has(name) && name !== "NativePrompt") {
      this.endBindingDrag();
    }
  }

  /** Skill-opened native windows admit only once their original artwork is resident. */
  preloadWindow(name) {
    if (this.windows.has(name)) return Promise.resolve();
    const existing = this.windowPreloads.get(name);
    if (existing) return existing.promise;
    if (!WINDOWS.has(name) || !this.index || this.disposed) {
      return Promise.reject(new Error(`Unavailable UI window ${name}`));
    }
    const entry = { resource: null, promise: null };
    this.windowPreloads.set(name, entry);
    entry.promise = loadVisualBundle(
      this.index.bundles[this.windowBundleName(name)],
      this.services,
      this.controller.signal,
    )
      .then((resource) => {
        if (this.disposed || this.windowPreloads.get(name) !== entry) {
          resource.destroy();
          throw new DOMException("UI closed", "AbortError");
        }
        entry.resource = resource;
      })
      .catch((error) => {
        if (this.windowPreloads.get(name) === entry) {
          this.windowPreloads.delete(name);
        }
        throw error;
      });
    return entry.promise;
  }

  clearWindowPreloads() {
    for (const entry of this.windowPreloads.values()) entry.resource?.destroy();
    this.windowPreloads.clear();
  }

  preloadedWindowError(name) {
    if (this.windows.has(name)) return null;
    return this.windowPreloads.get(name)?.resource
      ? null
      : "The original window artwork is still being prepared";
  }

  async loadWindow(name, signal) {
    const prepared = this.windowPreloads.get(name);
    if (prepared && !prepared.resource) await prepared.promise;
    const resource =
      prepared?.resource ??
      (await loadVisualBundle(
        this.index.bundles[this.windowBundleName(name)],
        this.services,
        signal,
      ));
    this.windowPreloads.delete(name);
    return this.mountWindow(name, resource, signal);
  }

  mountWindow(name, resource, signal) {
    let panel = null;
    try {
      signal.throwIfAborted();
      panel = new UISurface(this, name, resource, windowSize(name, resource));
      panel.borrow(this.hud.basic);
      resource = null;
      this.compose(panel);
      this.addWindowChrome(panel);
      panel.renderArtwork();
      signal.throwIfAborted();
      this.windows.set(name, panel);
      this.front(panel);
      this.positionWindow(panel, panel.x, panel.y);
      if (!INVITATION_WINDOWS.has(name)) {
        this.hooks.clearInput();
        this.focusWindow(panel);
      }
      if (name === "MiniMap") this.refreshMinimap(panel);
      this.refreshProfilePanel(panel);
      if (name === "GameLogs") this.logs.refresh();
      return panel;
    } catch (error) {
      if (this.windows.get(name) === panel) this.windows.delete(name);
      if (panel) panel.destroy();
      else resource?.destroy();
      throw error;
    }
  }

  windowBundleName(name) {
    if (name === "GameLogs") return "MesoDrop";
    if (name === "NativePrompt") {
      return promptBundleName(this.promptRequest?.request);
    }
    if (INVITATION_WINDOWS.has(name)) return "TradingRoom";
    if (name === "QuickSlotConfig" || name === "KeyConfigNotice") {
      return "KeyConfig";
    }
    return name === "Revive" ? "Notice" : name;
  }

  focusWindow(panel) {
    if (panel.name === "QuickSlotConfig") {
      panel.element.focus({ preventScroll: true });
    } else if (panel.name === "MesoDrop") {
      panel.mesoInput.focus();
      panel.mesoInput.select();
    } else if (panel.name === "NativePrompt" && panel.promptInput) {
      panel.promptInput.focus();
      panel.promptInput.select();
    } else if (MODAL_WINDOWS.has(panel.name)) {
      panel.element.querySelector("button")?.focus();
    } else {
      this.hooks.focusGame();
    }
  }

  compose(panel) {
    if (panel.name === "GameLogs") return layoutGameLogs(panel);
    if (panel.name === "QuickSlotConfig") return layoutQuickSlotConfig(panel);
    if (panel.name === "NativePrompt") return layoutPrompt(panel);
    if (panel.name === "Quest") {
      panel.nativeClose = true;
      if (!this.hooks.onQuestJournal) {
        throw new Error("Quest journal owner is not attached");
      }
      panel.dialogCleanup = this.hooks.onQuestJournal(panel);
      panel.cleanups.push(() => panel.dialogCleanup?.());
      return;
    }
    if (panel.name === "KeyConfigNotice") return layoutKeyNotice(panel);
    if (panel.name === "MesoDrop") return layoutMesoDialog(panel);
    if (layoutLocalWindow(panel)) return;
    layoutWindow(panel);
    if (panel.name === "UtilDlgEx") {
      this.mountDialog(panel);
    }
  }

  /** Browser drag handles do not add dismiss controls to native modal/HUD popup artwork. */
  usesNativeDismissal(panel) {
    return (
      POPUP_POSITIONS[panel.name] ||
      INVITATION_WINDOWS.has(panel.name) ||
      panel.name === "KeyConfigNotice" ||
      panel.name === "MesoDrop" ||
      panel.name === "UtilDlgEx" ||
      panel.name === "NativePrompt" ||
      panel.name === "QuickSlotConfig" ||
      panel.nativeClose
    );
  }

  addWindowChrome(panel) {
    if (panel.noDrag) {
      panel.position(0, 0);
      return;
    }
    this.placeNewWindow(panel);
    const strip = document.createElement("div");
    strip.className = "maple-ui-drag";
    strip.dataset.cursorState = "5";
    strip.style.width = `calc(100% - ${panel.name === "MiniMap" ? panel.minimapChromeWidth : 24}px)`;
    panel.listen(strip, "pointerdown", (event) => this.beginDrag(event, panel));
    panel.element.prepend(strip);
    panel.dragStrip = strip;
    if (this.usesNativeDismissal(panel)) return;
    panel.closeControl = panel.button(
      "BtClose",
      panel.width - 17,
      panel.name === "MiniMap" && panel.minimapDisplayMode === 2 ? 4 : 6,
      {
        label: `Close ${panel.name}`,
        action: () => this.close(panel.name),
      },
    );
  }

  placeNewWindow(panel) {
    const remembered = this.windowPositions.get(panel.name);
    if (remembered) {
      this.positionWindow(panel, remembered.x, remembered.y);
      return;
    }
    if (INVITATION_WINDOWS.has(panel.name)) {
      this.positionInvitation(panel);
      return;
    }
    const initial = POPUP_POSITIONS[panel.name];
    if (initial) {
      this.positionWindow(panel, initial[0], initial[1]);
      return;
    }
    if (panel.name === "SkillMacro") {
      const skill = this.windows.get("Skill");
      this.positionWindow(panel, skill.x + skill.width, skill.y);
      return;
    }
    const offset = this.windows.size * 18;
    const x =
      panel.name === "WorldMap"
        ? 67
        : panel.name === "FamilyTree"
          ? 111
          : (800 - panel.width) / 2 + offset;
    const y =
      panel.name === "WorldMap"
        ? 0
        : panel.name === "FamilyTree"
          ? 107
          : 70 + offset;
    this.positionWindow(panel, x, y);
  }

  positionWindow(panel, x, y) {
    if (panel.noDrag) {
      panel.position(0, 0);
      return;
    }
    // SkillMacro is an attached child (008a8504/008a8926), not a second free window.
    let macro = panel.name === "Skill" ? this.windows.get("SkillMacro") : null;
    if (panel.name === "SkillMacro") {
      macro = panel;
      panel = this.windows.get("Skill");
      x -= panel.width;
    }
    const left = -this.offsetX / this.scale;
    const top = -this.offsetY / this.scale;
    const right = left + this.viewportWidth / this.scale;
    const bottom = top + this.viewportHeight / this.scale;
    let width = panel.name === "MonsterBook" ? 506 : panel.width;
    let height = panel.height;
    let layerLeft = 0;
    let layerTop = 0;
    for (const layer of panel.layers) {
      if (layer.element.hidden || !layer.root.visible) continue;
      layerLeft = Math.min(layerLeft, layer.x);
      layerTop = Math.min(layerTop, layer.y);
      width = Math.max(width, layer.x + layer.width);
      height = Math.max(height, layer.y + layer.height);
    }
    if (macro) {
      width = Math.max(width, panel.width + macro.width);
      height = Math.max(height, macro.height);
    }
    const minX = left - layerLeft;
    const maxX = Math.max(minX, right - width);
    // An over-tall attachment must never pull the title/drag strip above the viewport.
    const minY = top - layerTop;
    const maxY = Math.max(minY, bottom - height);
    panel.position(
      Math.max(minX, Math.min(maxX, x)),
      Math.max(minY, Math.min(maxY, y)),
    );
    if (macro) macro.position(panel.x + panel.width, panel.y);
    this.rememberWindowPosition(panel);
  }

  rememberWindowPosition(panel) {
    if (
      !WINDOWS.has(panel.name) ||
      !panel.dragStrip ||
      panel.noDrag ||
      panel.name === "SkillMacro"
    ) {
      return;
    }
    let position = this.windowPositions.get(panel.name);
    if (position?.x === panel.x && position?.y === panel.y) return;
    this.positionsDirty = true;
    if (!position) {
      position = { x: panel.x, y: panel.y };
      this.windowPositions.set(panel.name, position);
    } else {
      position.x = panel.x;
      position.y = panel.y;
    }
  }

  restoreWindowPositions() {
    try {
      this.windowPositions = loadWindowPositions(WINDOWS);
    } catch (error) {
      this.recordError(error);
    }
    try {
      this.windowTabs = loadWindowTabs();
    } catch (error) {
      this.recordError(error);
    }
  }

  /** Browser-only tab preferences; callers supply currently selectable source values. */
  restoreTab(key, choices, fallback = choices[0]) {
    const saved = this.windowTabs.get(key);
    return choices.includes(saved) ? saved : fallback;
  }

  rememberTab(key, value) {
    if (this.windowTabs.get(key) === value) return;
    this.windowTabs.set(key, value);
    try {
      saveWindowTabs(this.windowTabs);
    } catch (error) {
      this.recordError(error);
    }
  }

  persistWindowPositions() {
    if (!this.positionsDirty) return;
    this.positionsDirty = false;
    try {
      saveWindowPositions(this.windowPositions, WINDOWS);
    } catch (error) {
      this.recordError(error);
    }
  }

  /** FadeYesNo is a top-level window, not a status-client child (+22).
   * 00522c73/00522e65/00523359 use screen y508; keep browser HUD-right anchoring.
   * Original anchors the panel 181px from the right edge (not the 6px HUD margin)
   * and 10px higher than the browser y508 baseline (actual plane y498). */
  positionInvitation(panel) {
    panel.position(800 - panel.width - 181, 498);
  }

  front(panel) {
    if (panel.name === "SkillMacro") panel = this.windows.get("Skill");
    this.raiseWindow(panel);
    const macro =
      panel.name === "Skill" ? this.windows.get("SkillMacro") : null;
    if (macro) this.raiseWindow(macro);
    const modal = MODAL_WINDOWS.has(panel.name) ? panel : this.modal();
    if (modal && modal !== panel) this.raiseWindow(modal);
    if (this.cursor) {
      this.root.setChildIndex(
        this.cursor.surface.root,
        this.root.children.length - 1,
      );
    }
    // Keep DOM nodes attached during pointerdown so native click/focus survives.
    let depth = 1;
    for (const window of this.windows.values()) {
      window.element.style.zIndex = String(depth++);
    }
    this.syncModalState();
  }

  raiseWindow(panel) {
    this.root.setChildIndex(panel.root, this.root.children.length - 1);
    this.windows.delete(panel.name);
    this.windows.set(panel.name, panel);
  }

  close(name, committed = false) {
    if (!this.canCloseWindow(name, committed)) return false;
    const current = this.windows.get(name);
    const requestClose =
      current?.requestClose ?? current?.dialogCleanup?.requestClose;
    if (!committed && requestClose) {
      return this.requestWindowClose(current, requestClose);
    }
    if (name === "KeyConfigNotice" && !committed) {
      return answerKeyNotice(this, false).catch((error) => {
        this.report(error);
        return false;
      });
    }
    return this.retireWindow(name, committed);
  }

  retireWindow(name, committed) {
    this.pending.get(name)?.controller.abort();
    this.pending.delete(name);
    const panel = this.windows.get(name);
    if (name === "QuickSlotConfig") closeQuickSlotConfig(this, committed);
    if (!panel) return false;
    if (name === "KeyConfig" && !this.prepareKeyConfigClose(panel, committed)) {
      return false;
    }
    if (name === "KeyConfig") this.closeQuickCapture(committed);
    if (name === "Skill") {
      this.pending.get("SkillMacro")?.controller.abort();
      this.pending.delete("SkillMacro");
      const macro = this.windows.get("SkillMacro");
      if (macro) this.removeWindow(macro);
    }
    this.removeWindow(panel);
    return true;
  }

  async requestWindowClose(panel, requestClose) {
    if (panel.closePending) return false;
    panel.closePending = true;
    try {
      const result = await requestClose();
      if (
        this.windows.get(panel.name) === panel &&
        (result === true || result?.ok)
      ) {
        this.close(panel.name, true);
      }
    } catch (error) {
      this.report(error);
    } finally {
      panel.closePending = false;
    }
    return this.windows.get(panel.name) !== panel;
  }

  canCloseWindow(name, committed) {
    const panel = this.windows.get(name);
    if (!committed && this.blocksWindowClose(panel, name)) return false;
    return !(name === "KeyConfig" && this.bindings?.saving);
  }

  panelRejectsClose(panel) {
    return (
      panel?.closePending ||
      panel?.canClose?.() === false ||
      panel?.dialogCleanup?.canClose?.() === false
    );
  }

  blocksWindowClose(panel, name) {
    if (this.panelRejectsClose(panel)) return true;
    if (name === "Skill") {
      const macro = this.windows.get("SkillMacro");
      if (this.panelRejectsClose(macro)) return true;
    }
    if (name !== "NativePrompt" && this.hooks.isOperationPending?.()) {
      return true;
    }
    if (name === "Revive") return true;
    if (name === "MesoDrop" && this.windows.get(name)?.mesoPending) {
      return true;
    }
    const modal = this.modal();
    return modal && modal.name !== name;
  }

  prepareKeyConfigClose(panel, committed) {
    if (committed || !this.bindings) return true;
    if (this.bindings.hasChanges()) {
      cancelKeys(panel);
      return false;
    }
    this.bindings.cancel();
    return true;
  }

  closeQuickCapture(committed) {
    this.pending.get("QuickSlotConfig")?.controller.abort();
    if (this.quickCapture === null) return;
    closeQuickSlotConfig(this, committed);
    const panel = this.windows.get("QuickSlotConfig");
    if (panel) this.removeWindow(panel);
  }

  removeWindow(panel) {
    if (
      this.bindingDrag &&
      panel.name !== "NativePrompt" &&
      !INVITATION_WINDOWS.has(panel.name)
    ) {
      this.endBindingDrag();
    }
    panel.mapController?.abort();
    this.rememberWindowPosition(panel);
    this.persistWindowPositions();
    if (this.drag?.panel === panel) this.releaseWindowDrag();
    this.windows.delete(panel.name);
    panel.destroy();
    this.syncModalState();
    this.hideTooltip();
    if (!INVITATION_WINDOWS.has(panel.name)) {
      this.hooks.clearInput();
      const modal = this.modal();
      if (modal) modal.element.querySelector("button")?.focus();
      else this.hooks.focusGame();
    }
    this.hooks.onCloseWindow?.(panel.name);
  }

  closeAll() {
    if (this.hooks.isOperationPending?.()) return false;
    for (const panel of this.windows.values()) {
      if (
        panel.dialogCleanup?.requestClose ||
        panel.requestClose ||
        this.panelRejectsClose(panel)
      ) {
        return false;
      }
    }
    settlePrompt(this, this.promptRequest, null);
    this.releaseWindowDrag();
    this.endBindingDrag();
    this.bindings?.cancel();
    this.quickCapture = null;
    this.quickCaptureDraft = null;
    this.keyNotice = null;
    this.retireAllWindows();
    this.hideTooltip();
    this.drag = null;
    this.syncModalState();
    return true;
  }

  retireAllWindows() {
    for (const task of this.pending.values()) task.controller.abort();
    this.pending.clear();
    for (const panel of this.windows.values()) {
      this.rememberWindowPosition(panel);
      panel.mapController?.abort();
      panel.destroy();
    }
    this.windows.clear();
    this.persistWindowPositions();
  }

  /** Ordinary map travel retires only field-borrowing controllers, not character UI. */
  async requestFieldTransition() {
    if (
      this.closingAll ||
      this.changingField ||
      this.hooks.isOperationPending?.()
    ) {
      return false;
    }
    this.changingField = true;
    try {
      await this.chat.waitForIdle();
      if (this.hooks.isOperationPending?.()) return false;
      if (this.fieldOwnsPrompt()) settlePrompt(this, this.promptRequest, null);
      if (!(await this.retireFieldControllers())) return false;
      this.releaseWindowDrag();
      this.endBindingDrag();
      this.hideTooltip();
      this.dialogNpc = null;
      this.syncModalState();
      return true;
    } finally {
      this.changingField = false;
    }
  }

  async retireFieldControllers() {
    const panels = Array.from(this.windows.values()).reverse();
    for (const panel of panels) {
      if (!FIELD_WINDOWS.has(panel.name)) continue;
      if (this.panelRejectsClose(panel)) return false;
      const requestClose =
        panel.requestClose ?? panel.dialogCleanup?.requestClose;
      if (requestClose) await this.requestWindowClose(panel, requestClose);
      else this.close(panel.name, true);
      if (this.windows.has(panel.name)) return false;
    }
    for (const name of FIELD_WINDOWS) {
      this.pending.get(name)?.controller.abort();
      this.pending.delete(name);
    }
    return true;
  }

  fieldOwnsPrompt() {
    const owner = this.promptRequest?.request.owner;
    if (!owner) return false;
    for (const name of FIELD_WINDOWS) {
      const panel = this.windows.get(name);
      if (
        owner === panel ||
        owner === panel?.operationOwner ||
        owner === panel?.dialogCleanup
      ) {
        return true;
      }
    }
    return false;
  }

  /** Session owners receive a real cancellation before any borrowed artwork is released. */
  async requestCloseAll() {
    if (this.closingAll || this.hooks.isOperationPending?.()) return false;
    this.closingAll = true;
    try {
      const keyConfig = this.windows.get("KeyConfig");
      if (keyConfig && this.bindings.hasChanges()) {
        cancelKeys(keyConfig);
        return false;
      }
      settlePrompt(this, this.promptRequest, null);
      const panels = Array.from(this.windows.values()).reverse();
      for (const panel of panels) {
        if (this.panelRejectsClose(panel)) return false;
        const requestClose =
          panel.requestClose ?? panel.dialogCleanup?.requestClose;
        if (requestClose) await this.requestWindowClose(panel, requestClose);
        else this.close(panel.name, true);
        if (this.windows.has(panel.name)) return false;
      }
      return this.closeAll();
    } finally {
      this.closingAll = false;
    }
  }

  notice(text) {
    const message = String(text).slice(0, 1800);
    this.status(message);
    return this.prompt({ kind: "confirm", text: message, owner: this.modal() });
  }

  /** Only the quest owner may interpret original NPC/quest data or mutate quest state. */
  showNpc(record) {
    this.validateNpcRecord(record);
    if (typeof record.canInteract !== "function" || !record.canInteract()) {
      this.notice(
        "NPC interaction is no longer available. Select an eligible visible NPC while alive.",
      );
      return;
    }
    if (this.windows.get("UtilDlgEx")?.dialogCleanup?.canClose?.() === false) {
      return;
    }
    this.dialogNpc = record;
    return this.refreshDialog();
  }

  validateNpcRecord(record) {
    const id = record?.templateId;
    const validId =
      (typeof id === "string" && /^\d{1,8}$/.test(id)) ||
      (Number.isSafeInteger(id) && id >= 0 && id <= 99999999);
    if (!record || typeof record.name !== "string" || !validId) {
      throw new Error("Invalid NPC UI interaction record");
    }
  }

  refreshDialog() {
    const panel = this.windows.get("UtilDlgEx");
    if (!panel) {
      return this.open("UtilDlgEx");
    }
    if (
      panel.dialogCleanup?.canClose?.() === false ||
      this.pending.has("UtilDlgEx")
    ) {
      return;
    }
    return this.replaceDialogue(panel);
  }

  async replaceDialogue(previous) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.controller.signal]);
    const task = { controller, promise: null };
    task.promise = this.loadWindow("UtilDlgEx", signal);
    this.pending.set("UtilDlgEx", task);
    try {
      const panel = await task.promise;
      previous.destroy();
      return panel;
    } catch (error) {
      if (!previous.disposed) {
        this.dialogNpc = previous.dialogNpc;
        this.windows.set("UtilDlgEx", previous);
        this.front(previous);
      }
      throw error;
    } finally {
      if (this.pending.get("UtilDlgEx") === task) {
        this.pending.delete("UtilDlgEx");
      }
    }
  }

  mountDialog(panel) {
    this.prepareDialog(panel);
    if (!this.hooks.onNpcDialogue) {
      throw new Error("NPC dialogue owner is not attached");
    }
    panel.dialogNpc = this.dialogNpc;
    panel.dialogCleanup = this.hooks.onNpcDialogue(panel, this.dialogNpc);
  }

  prepareDialog(panel) {
    if (panel.dialogCleanup?.canClose?.() === false) {
      throw new Error("Dialogue request is pending");
    }
    panel.dialogCleanup?.();
    panel.dialogCleanup = null;
    panel.content.replaceChildren();
    panel.dialogClose?.setVisible(true);
    if (!panel.dialogDisposal) {
      panel.dialogDisposal = true;
      panel.cleanups.push(() => panel.dialogCleanup?.());
    }
  }

  /** Shared visible confirmation action; normal commands cannot invoke an unseen/pending dialog. */
  confirmDialog() {
    if (this.modal()?.name === "NativePrompt") {
      return submitPrompt(this.modal());
    }
    if (this.modal()?.name === "Revive") return this.confirmRevival();
    if (this.modal()?.name === "KeyConfigNotice") {
      return answerKeyNotice(this, true);
    }
    return false;
  }

  openQuickSlotCapture() {
    if (!this.bindings || this.quickCapture !== null) return;
    this.quickCapture = -1;
    const draft = this.bindings.active.quickSlots.slice();
    this.quickCaptureDraft = draft;
    this.hooks.clearInput();
    this.open("QuickSlotConfig").catch((error) => {
      if (this.quickCaptureDraft === draft) this.close("QuickSlotConfig");
      this.report(error);
    });
  }

  showTooltip(content, x, y, anchor = null) {
    if (this.disposed || this.bindingDrag || !this.visible) return;
    this.hideTooltip();
    this.tooltipAnchor = anchor;
    if (anchor) anchor.setAttribute("aria-describedby", this.tooltip.id);
    const position = { x, y };
    const item = content?.item;
    const source = item ? itemTooltipSource(content) : content?.source;
    if (item && !source) {
      this.prepareTooltip(content, position, anchor);
      return;
    }
    try {
      this.renderPreparedTooltip(content, source, position);
    } catch (error) {
      this.hideTooltip();
      this.report(error);
    }
  }

  async prepareTooltip(content, position, anchor) {
    const controller = new AbortController();
    this.tooltipController = controller;
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    let source;
    try {
      source = await prepareItemTooltipSource(this, content, signal);
      signal.throwIfAborted();
      if (this.tooltipController !== controller) return;
      if (this.disposed || !this.visible || (anchor && !anchor.isConnected)) {
        this.hideTooltip();
        return;
      }
      const prepared = source;
      this.tooltipResource = prepared.resource ?? null;
      source = null;
      this.renderPreparedTooltip(content, prepared, position);
    } catch (error) {
      if (this.tooltipController !== controller) return;
      this.hideTooltip();
      if (error.name !== "AbortError") this.report(error);
    } finally {
      source?.resource?.destroy();
    }
  }

  renderPreparedTooltip(content, source, position) {
    renderTooltip(this, content, source);
    this.tooltip.hidden = false;
    const left = -this.offsetX / this.scale;
    const top = -this.offsetY / this.scale;
    const right = left + this.viewportWidth / this.scale;
    const bottom = top + this.viewportHeight / this.scale;
    positionTooltip(this.tooltip, position, { left, top, right, bottom });
    this.tooltipIcon?.renderArtwork();
    if (this.cursor) {
      this.root.setChildIndex(
        this.cursor.surface.root,
        this.root.children.length - 1,
      );
    }
  }

  hideTooltip() {
    this.tooltipController?.abort();
    this.tooltipController = null;
    this.tooltipAnchor?.removeAttribute("aria-describedby");
    this.tooltipAnchor = null;
    this.tooltipIcon?.destroy();
    this.tooltipIcon = null;
    this.tooltipResource?.destroy();
    this.tooltipResource = null;
    this.tooltip.hidden = true;
  }

  toggleInventorySkin(panel) {
    if (!panel.fullSkin) {
      panel.fullSkin = panel.image("Item/FullBackgrnd", 0, 0);
    } else panel.fullSkin.container.visible = !panel.fullSkin.container.visible;
    panel.root.setChildIndex(panel.fullSkin.container, 0);
    const full = panel.fullSkin.container.visible;
    panel.sprites[0].container.visible = !full;
    const asset = panel.assets[full ? "Item/FullBackgrnd" : "Item/backgrnd"];
    panel.width = asset.width;
    panel.height = asset.height;
    panel.element.style.width = `${panel.width}px`;
    panel.element.style.height = `${panel.height}px`;
    panel.dragStrip.style.width = `${panel.width - 24}px`;
    panel.closeControl.position(panel.width - 17, 6);
    panel.gatherControl.position(panel.width - 32, 6);
    panel.fullControl.position(panel.width - 47, 6);
    panel.smallControl.position(panel.width - 47, 6);
    panel.fullControl.setVisible(!full);
    panel.smallControl.setVisible(full);
    panel.inventorySignature = null;
    this.refreshProfilePanel(panel);
    this.positionWindow(panel, panel.x, panel.y);
    (full ? panel.smallControl : panel.fullControl).element.focus();
    panel.renderArtwork();
  }

  setScene(scene) {
    if (this.scene !== scene) this.close("MesoDrop", true);
    this.hideTooltip();
    if (this.scene !== scene) this.close("Revive", true);
    this.endBindingDrag();
    this.scene = scene;
    const panel = this.windows.get("MiniMap");
    if (panel) this.refreshMinimap(panel);
    for (const window of this.windows.values()) window.localRefresh?.();
  }

  refreshMinimap(panel) {
    panel.mapController?.abort();
    panel.mapController = new AbortController();
    const signal = AbortSignal.any([
      panel.mapController.signal,
      this.controller.signal,
    ]);
    replaceMinimap(this, panel, signal).catch((error) => {
      if (!signal.aborted) {
        panel.mapStatus.textContent = panel.mapResource
          ? "Minimap load failed; previous complete artwork retained."
          : "Minimap load failed.";
      }
      this.report(error);
    });
  }
  /** World-only compositing inspection gate; does not destroy or alter window state. */
  setVisible(visible) {
    if (typeof visible !== "boolean") {
      throw new Error("UI visibility must be boolean");
    }
    this.visible = visible;
    this.root.visible = visible;
    this.host.hidden = !visible;
    this.endDrag();
    this.endBindingDrag();
    if (this.cursor) this.cursor.surface.root.visible = false;
    this.cursor?.setVisible(visible);
    this.hooks.clearInput();
    if (!visible) this.hooks.focusGame();
  }

  update(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("Invalid UI elapsed milliseconds");
    }
    this.updateRevival();
    this.notices?.update(ms);
    if (!this.visible) return;
    this.hud?.update(ms);
    finishGaugeWarnings(this.hud);
    this.updatePanels(ms);
    this.temporaryStats?.update();
    this.cursor?.update(ms);
  }

  updatePanels(ms) {
    const minimap = this.windows.get("MiniMap");
    if (minimap && this.scene) {
      updateMinimap(
        minimap,
        this.scene.presentation.x,
        this.scene.presentation.y,
        this.hooks.minimapPeers?.(),
      );
    }
    for (const panel of this.windows.values()) {
      panel.update(ms);
      panel.invitationUpdate?.();
    }
    for (const panel of this.windows.values()) {
      panel.dialogCleanup?.update?.(ms);
    }
    this.windows.get("CashShop")?.cashUpdate?.(ms);
    this.logs.update(ms);
  }

  updateRevival() {
    if (
      this.windows.has("Revive") &&
      !this.revivalPending &&
      !this.revivalAutoConfirmed &&
      (this.hooks.now?.() ?? performance.now()) - this.revivalOpenedAt >
        REVIVAL_POLICY.autoConfirmMs
    ) {
      this.revivalAutoConfirmed = this.confirmRevival();
    }
  }

  resize(width = this.viewportWidth, height = this.viewportHeight) {
    this.hideTooltip();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error("Invalid UI viewport");
    }
    this.scale = Math.min(1, width / 800, height / 600);
    this.offsetX = (width - 800 * this.scale) / 2;
    this.offsetY = height - 600 * this.scale;
    this.root.scale.set(this.scale);
    this.root.position.set(this.offsetX, this.offsetY);
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.bounds.left = -this.offsetX / this.scale;
    this.bounds.top = -this.offsetY / this.scale;
    this.bounds.right = this.bounds.left + width / this.scale;
    this.bounds.bottom = this.bounds.top + height / this.scale;
    this.releaseWindowDrag();
    for (const panel of this.windows.values()) {
      if (panel.name === "SkillMacro") continue;
      this.positionWindow(panel, panel.x, panel.y);
    }
    this.syncDomLayout();
    this.notices?.resize(this.bounds);
    this.logs?.resize();
    this.persistWindowPositions();
  }

  /** Track canvas resize and ancestor layout changes without querying layout in the animation loop. */
  observeLayout() {
    this.layoutHandler = this.scheduleLayout.bind(this);
    this.layoutCommit = this.commitLayout.bind(this);
    this.layoutObserver = new ResizeObserver(this.layoutHandler);
    this.layoutObserver.observe(this.app.canvas);
    this.layoutObserver.observe(this.host.parentElement);
    this.layoutMutations = new MutationObserver(this.layoutHandler);
    this.layoutMutations.observe(this.app.canvas, {
      attributes: true,
      attributeFilter: ["class", "style", "width", "height"],
    });
    let ancestor = this.host.parentElement,
      depth = 0;
    while (ancestor && depth++ < 32) {
      this.layoutMutations.observe(ancestor, {
        attributes: true,
        childList: true,
      });
      ancestor = ancestor.parentElement;
    }
    if (ancestor) {
      throw new Error("UI ancestor layout depth exceeds supported bound");
    }
    window.addEventListener("resize", this.layoutHandler);
    window.addEventListener("scroll", this.layoutHandler, true);
  }

  scheduleLayout() {
    if (this.disposed || this.layoutFrame !== null) return;
    this.layoutFrame = requestAnimationFrame(this.layoutCommit);
  }

  commitLayout() {
    this.layoutFrame = null;
    if (!this.disposed) this.syncDomLayout();
  }

  syncDomLayout() {
    const parent = this.host.parentElement;
    const canvasRect = this.app.canvas.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    if (
      canvasRect.width <= 0 ||
      canvasRect.height <= 0 ||
      parent.offsetWidth <= 0 ||
      parent.offsetHeight <= 0
    ) {
      return;
    }
    const parentScaleX = parentRect.width / parent.offsetWidth;
    const parentScaleY = parentRect.height / parent.offsetHeight;
    if (parentScaleX <= 0 || parentScaleY <= 0) return;
    const ratioX = canvasRect.width / this.viewportWidth / parentScaleX;
    const ratioY = canvasRect.height / this.viewportHeight / parentScaleY;
    const left =
      (canvasRect.left - parentRect.left) / parentScaleX -
      parent.clientLeft +
      parent.scrollLeft;
    const top =
      (canvasRect.top - parentRect.top) / parentScaleY -
      parent.clientTop +
      parent.scrollTop;
    this.host.style.left = `${left + this.offsetX * ratioX}px`;
    this.host.style.top = `${top + this.offsetY * ratioY}px`;
    this.host.style.transform = `scale(${this.scale * ratioX},${this.scale * ratioY})`;
    this.screenScaleX = this.scale * ratioX * parentScaleX;
    this.screenScaleY = this.scale * ratioY * parentScaleY;
    this.layoutGeneration++;
    for (const panel of this.windows.values()) panel.renderArtwork();
    this.notices?.update(0);
  }

  onKey(event) {
    if (!this.acceptsKey(event)) return;
    const modal = this.modal();
    const cash = this.windows.get("CashShop");
    if (!modal && cash?.cashKey?.(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (
      this.captureBoundWindowToggle(event, modal?.name ?? this.pendingModal())
    ) {
      return;
    }
    if (this.capturePriorityKey(event, modal)) return;
    if (this.captureControlInput(event, modal)) return;
    if (this.captureWindowKey(event)) return;
    this.captureBindingKey(event);
  }

  captureBindingKey(event) {
    const index = keyIndexForCode(event.code);
    const binding = this.bindings?.lookup(event.code);
    if (index >= 0 && isReleaseBinding(binding)) {
      if (!event.repeat) {
        this.releaseBindings[index] = binding;
        this.releaseGenerations[index] = this.hooks.inputGeneration();
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!event.repeat && this.bindings?.activateCode(event.code)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  onKeyUp(event) {
    this.bindings?.releaseCode(event.code);
    if (this.windows.get("CashShop")?.cashPreview?.keyUp(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    const index = keyIndexForCode(event.code);
    if (index < 0) return false;
    const binding = this.releaseBindings[index];
    this.releaseBindings[index] = null;
    if (!this.releaseBindingAllowed(event, index, binding)) return false;
    event.preventDefault();
    // Never stop key-up propagation: PlayerInput must release even after chat takes focus.
    return this.bindings.activateKey(index);
  }

  releaseBindingAllowed(event, index, binding) {
    return (
      Boolean(binding) &&
      isReleaseBinding(binding) &&
      this.releaseGenerations[index] === this.hooks.inputGeneration() &&
      this.bindings?.lookup(event.code) === binding &&
      this.acceptsKey(event) &&
      !this.blocksGameplay() &&
      !editingTarget(event.target)
    );
  }

  /** Bubble after local controls: a scrollbar/editor may consume its own keys first. */
  routeGameplayKey(event) {
    if (
      event.isComposing ||
      event.defaultPrevented ||
      event.metaKey ||
      !this.ownsKeyTarget(event.target) ||
      this.blocksGameplay() ||
      editingTarget(event.target)
    ) {
      return false;
    }
    if (this.isButtonActivation(event)) {
      return false;
    }
    if (this.bindings?.actionForCode(event.code)) {
      this.hooks.macros?.()?.interrupt();
    }
    this.hooks.keyDown(event);
    return event.defaultPrevented;
  }

  isButtonActivation(event) {
    return (
      event.target?.matches?.("button") && ["Enter", " "].includes(event.key)
    );
  }

  ownsKeyTarget(target) {
    return (
      target === this.app.canvas ||
      (this.visible && this.host.contains(target)) ||
      (target === document.body && this.keyboardContext)
    );
  }

  capturePriorityKey(event, modal) {
    const loading = this.pendingModal();
    if (loading) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") this.close(loading);
      return true;
    }
    if (this.captureCarryKey(event, modal)) return true;
    if (modal?.name === "QuickSlotConfig" && captureQuickKey(this, event)) {
      return true;
    }
    if (modal) return this.captureModalKey(event, modal);
    if (captureQuickKey(this, event)) return true;
    return this.chat?.handle(event);
  }

  /** A modal window's own bound action may close it without enabling unrelated gameplay. */
  captureBoundWindowToggle(event, name) {
    if (
      !name ||
      !NORMAL_UI_NAMES.includes(name) ||
      editingTarget(event.target) ||
      bindingAction(this.bindings?.lookup(event.code)) !== name
    ) {
      return false;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) this.toggleWindow(name);
    return true;
  }

  captureCarryKey(event, modal) {
    if (this.bindingDrag && !modal && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.endBindingDrag();
      return true;
    }
    return false;
  }

  captureWindowKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const last = Array.from(this.windows.keys()).pop();
      if (last) this.close(last);
      else if (this.chat?.state !== 1) this.chat.close();
      else this.activate("GameMenu");
      return true;
    }
    if (event.key === "Enter" && event.target === this.app.canvas) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.chat?.open();
      return true;
    }
    return false;
  }
  captureControlInput(event, modal) {
    if (!this.host.contains(event.target)) return false;
    if (
      event.target.matches("button") &&
      (event.key === "Enter" ||
        event.key === " " ||
        (event.target.dataset.keyIndex !== undefined &&
          (event.key === "Delete" || event.key === "Backspace")))
    ) {
      return true;
    }
    if (!modal && !editingTarget(event.target)) return false;
    this.hooks.clearInput();
    // Let the owning editor receive keydown; routeGameplayKey rejects editors and modals.
    return true;
  }

  acceptsKey(event) {
    if (!this.visible || !this.index || event.metaKey || event.isComposing) {
      return false;
    }
    return this.ownsKeyTarget(event.target);
  }

  modal() {
    let modal = null;
    for (const panel of this.windows.values()) {
      if (MODAL_WINDOWS.has(panel.name)) {
        modal = panel;
      }
    }
    return modal;
  }

  /** A native modal owns input while its original artwork is being loaded. */
  pendingModal() {
    for (const name of this.pending.keys()) {
      if (MODAL_WINDOWS.has(name) && !this.windows.has(name)) return name;
    }
    return null;
  }

  syncModalState() {
    const modal = this.modal();
    const loading = this.pendingModal() !== null;
    if (modal && modal.name !== "NativePrompt") this.endBindingDrag();
    if (this.hud) this.hud.element.inert = loading || Boolean(modal);
    for (const panel of this.windows.values()) {
      panel.element.inert = loading || Boolean(modal && panel !== modal);
      if (MODAL_WINDOWS.has(panel.name)) {
        panel.element.tabIndex = -1;
        panel.element.setAttribute("role", "dialog");
        panel.element.setAttribute("aria-modal", String(panel === modal));
      }
    }
  }

  blocksGameplay() {
    return Boolean(
      this.modal() ||
      this.windows.has("CashShop") ||
      this.pendingModal() ||
      this.keyNotice !== null ||
      this.quickCapture !== null,
    );
  }

  captureModalKey(event, panel) {
    if (event.key === "Enter" && !event.isComposing) {
      if (panel.name === "NativePrompt") {
        return this.capturePromptEnter(event, panel);
      }
      if (panel.name === "MesoDrop") {
        return this.captureMesoEnter(event, panel);
      }
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close(panel.name);
      return true;
    }
    if (!panel.element.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      panel.element.querySelector("button")?.focus();
      this.hooks.clearInput();
      return true;
    }
    if (event.key !== "Tab") return false;
    this.cycleModalFocus(event, panel);
    return false;
  }

  capturePromptEnter(event, panel) {
    if (event.target === panel.promptCancel?.element) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) submitPrompt(panel);
    return true;
  }

  captureMesoEnter(event, panel) {
    if (event.target === panel.mesoCancel.element) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) submitMesoDrop(panel);
    return true;
  }

  cycleModalFocus(event, panel) {
    const buttons = Array.from(
      panel.element.querySelectorAll(FOCUSABLE),
    ).filter((element) => element.getClientRects().length > 0);
    const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
    if (event.target === edge) {
      event.preventDefault();
      buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
    }
  }

  onPointer(event) {
    if (!this.visible) return;
    if (this.captureBindingPointer(event)) return;
    this.bindingClickPointer = null;
    this.cursor?.move(event);
    const canvas = event.target === this.app.canvas;
    if (!canvas && !this.host.contains(event.target)) {
      this.keyboardContext = false;
      return;
    }
    this.keyboardContext = true;
    if (this.captureModalPointer(event)) return;
    if (event.button === 0) this.cursor?.press(event);
    if (canvas) {
      this.hooks.focusGame();
      return;
    }
    this.focusPointerTarget(event);
    for (const panel of this.windows.values()) {
      if (panel.element.contains(event.target)) {
        this.front(panel);
        break;
      }
    }
  }

  /** Native prose/buttons keep gameplay focus; real edit controls retain browser selection. */
  focusPointerTarget(event) {
    this.hooks.clearInput();
    const editor =
      editingTarget(event.target) ||
      editingTarget(event.target.closest?.("label")?.control);
    if (editor) return;
    event.preventDefault();
    if (!this.modal()) this.hooks.focusGame();
  }

  onDoubleClick(event) {
    if (
      !this.visible ||
      event.button !== 0 ||
      event.target !== this.app.canvas ||
      this.blocksGameplay()
    ) {
      return;
    }
    this.hooks
      .openUserInfoAt(event.clientX, event.clientY)
      .catch((error) => this.report(error));
  }

  /** 009e3ae6: carry consumes input; only a later left down places. */
  captureBindingPointer(event) {
    const drag = this.bindingDrag;
    if (!drag || this.modal()?.name === "NativePrompt") return false;
    event.stopImmediatePropagation();
    if (
      event.pointerId !== drag.pointerId ||
      event.button !== 0 ||
      drag.pressed
    ) {
      event.preventDefault();
      return true;
    }
    this.cursor?.move(event);
    this.bindingClickPointer = event.pointerId;
    if (event.pointerType === "mouse") {
      // MouseEvent.detail distinguishes native WM_LBUTTONDBLCLK before any mutation.
      // Cancelling pointerdown would suppress this compatibility mousedown event.
      drag.placing = true;
    } else {
      event.preventDefault();
      this.dropBinding(event);
    }
    return true;
  }

  onBindingMouseDown(event) {
    const drag = this.bindingDrag;
    if (!drag?.placing) return;
    drag.placing = false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.detail < 2) {
      return this.dropBinding(event);
    }
    if (drag.uid) {
      const entry = carriedInstance(this, drag);
      this.endBindingDrag();
      if (entry) useInventoryItem(this, entry);
      return;
    }
    const binding = drag.binding;
    const skillSource =
      this.windows.get("Skill")?.element.contains(drag.source.element) === true;
    this.endBindingDrag();
    if (binding.type === 2) {
      this.bindings.useItem(binding.id).catch((error) => this.report(error));
    } else if (binding.type === 1 && skillSource) {
      this.bindings.useSkill(binding.id);
    }
  }

  /** DOM click/double-click/contextmenu must not activate the consumed source or destination. */
  captureBindingClick(event) {
    if (this.modal()?.name === "NativePrompt") return;
    const pointerId = this.bindingDrag?.pointerId ?? this.bindingClickPointer;
    if (pointerId === null || pointerId === undefined) return;
    if (event.pointerId !== undefined && event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "dblclick") this.endBindingDrag();
  }

  captureModalPointer(event) {
    const modal = this.modal();
    if (!modal || modal.element.contains(event.target)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    modal.element.querySelector("button")?.focus();
    return true;
  }

  onFocus(event) {
    this.keyboardContext =
      event.target === this.app.canvas || this.host.contains(event.target);
    if (this.keyboardContext && (editingTarget(event.target) || this.modal())) {
      this.hooks.clearInput();
    }
  }

  beginDrag(event, panel) {
    if (
      event.button !== 0 ||
      this.drag ||
      this.bindingDrag ||
      this.pressedControl
    ) {
      return;
    }
    if (!this.screenScaleX || !this.screenScaleY) return;
    event.preventDefault();
    if (panel.name === "SkillMacro") panel = this.windows.get("Skill");
    this.hideTooltip();
    this.front(panel);
    this.hooks.clearInput();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.drag = {
      panel,
      capture: event.currentTarget,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: panel.x,
      startY: panel.y,
    };
  }

  onDrag(event) {
    this.cursor?.move(event);
    if (!this.visible) return;
    this.chat?.move(event);
    if (this.bindingDrag) {
      event.preventDefault();
      return;
    }
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const drag = this.drag;
    this.positionWindow(
      drag.panel,
      drag.startX + (event.clientX - drag.x) / this.screenScaleX,
      drag.startY + (event.clientY - drag.y) / this.screenScaleY,
    );
  }

  endDrag(event) {
    if (!this.acceptsDragRelease(event)) return;
    if (event?.type !== "pointerup") this.hideTooltip();
    this.releaseWindowDrag();
    if (event?.type !== "pointerup") this.pressedControl?.cancelPointer();
    this.chat?.endResize();
    this.finishBindingDrag(event);
    this.releaseCursor(event);
  }

  acceptsDragRelease(event) {
    if (event?.pointerId === undefined) return true;
    return !(
      (this.bindingDrag && event.pointerId !== this.bindingDrag.pointerId) ||
      (this.drag && event.pointerId !== this.drag.pointerId) ||
      (this.pressedControl && event.pointerId !== this.pressedControl.pointerId)
    );
  }

  finishBindingDrag(event) {
    const drag = this.bindingDrag;
    if (drag && event?.type === "pointerup") {
      drag.pressed = false;
      this.releaseBindingCapture(drag);
    } else if (event?.type !== "pointerup") {
      this.endBindingDrag();
      this.bindingClickPointer = null;
    }
  }

  releaseCursor(event) {
    this.cursor?.release(event);
    if (event?.type === "pointerup") this.cursor?.move(event);
    else if (this.cursor) this.cursor.surface.root.visible = false;
  }

  releaseWindowDrag() {
    const drag = this.drag;
    this.drag = null;
    if (drag) this.persistWindowPositions();
    if (drag?.capture.hasPointerCapture(drag.pointerId)) {
      drag.capture.releasePointerCapture(drag.pointerId);
    }
  }

  onCaptureLost(event) {
    if (
      this.drag?.pointerId === event.pointerId ||
      (this.bindingDrag?.capture &&
        this.bindingDrag.pointerId === event.pointerId)
    ) {
      this.endDrag(event);
    }
  }
  logicalPointer(event) {
    const rect = this.host.getBoundingClientRect();
    this.pointerPoint.x = (event.clientX - rect.left) / this.screenScaleX;
    this.pointerPoint.y = (event.clientY - rect.top) / this.screenScaleY;
    return this.pointerPoint;
  }
  /** Native 009e353d installs a click-carried icon without a held-pointer requirement. */
  beginBindingDrag(event, binding, sourceIndex, { source, path }) {
    if (
      event.button !== 0 ||
      this.blocksGameplay() ||
      this.drag ||
      this.bindingDrag ||
      this.pressedControl ||
      !this.bindings?.canCarry(binding, sourceIndex) ||
      !source?.entities.has(path)
    ) {
      return false;
    }
    event.preventDefault();
    this.hooks.clearInput();
    const palette =
      sourceIndex === null && binding.type >= 4 && binding.type <= 6;
    this.carryBinding(event, binding, sourceIndex, { source, path, palette });
    this.sound("DragStart");
    return true;
  }

  carryBinding(event, binding, sourceIndex, { source, path, palette = false }) {
    this.bindingClickPointer = event.pointerId ?? this.bindingClickPointer;
    this.bindingDrag = {
      binding: { type: binding.type, id: binding.id },
      sourceIndex,
      source,
      palette,
      capture: event.target,
      pointerId: this.bindingClickPointer,
      pressed: true,
    };
    this.cursor?.drag(source, path);
    this.hideTooltip();
  }

  /** 009e37c2 clears carry before dispatch, including rejected destinations. */
  dropBinding(event) {
    const drag = this.bindingDrag;
    if (!this.ownsCarriedPointer(drag, event)) return;
    const panel = this.windows.get("KeyConfig");
    const point = this.logicalPointer(event);
    const target = keyAtPoint(panel, point);
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (dropCarriedItem(this, event, element)) return;
    if (this.dropMacroSkill(drag, point, element)) return;
    const quickTarget = quickKeyAtPoint(this, point);
    const admitted =
      !this.blocksGameplay() &&
      this.bindings.canCarry(drag.binding, drag.sourceIndex);
    this.endBindingDrag();
    if (!admitted) return;
    let accepted = false;
    if (
      quickTarget !== null &&
      this.hud.quickSurface.element.contains(element)
    ) {
      return this.completeQuickDrop(event, drag, quickTarget, element).catch(
        (error) => this.report(error),
      );
    } else if (target !== null && panel.element.contains(element)) {
      accepted = this.placeKeyBinding(drag, target);
    }
    accepted = this.finishMacroSourceDrop(drag, accepted, element);
    if (accepted) this.sound("DragEnd");
  }

  async completeQuickDrop(event, drag, target, element) {
    const epoch = this.epoch;
    let accepted = await this.placeQuickBinding(event, drag, target);
    if (this.disposed || epoch !== this.epoch) return;
    accepted = this.finishMacroSourceDrop(drag, accepted, element);
    if (accepted) this.sound("DragEnd");
  }

  /** Compatibility MouseEvents inherit the pointer that admitted their carry. */
  ownsCarriedPointer(drag, event) {
    return (
      drag && (event.pointerId ?? this.bindingClickPointer) === drag.pointerId
    );
  }

  dropMacroSkill(drag, point, element) {
    const macro = this.windows.get("SkillMacro");
    if (!macro?.element.contains(element)) return false;
    const result = placeMacroSkill(macro, drag, point);
    if (result === null) return false;
    this.endBindingDrag();
    if (result.ok) this.sound("DragEnd");
    else this.status(result.reason);
    return true;
  }

  finishMacroSourceDrop(drag, accepted, element) {
    if (drag.macroSource && (accepted || element === this.app.canvas)) {
      const result = this.hooks
        .macros()
        .remove(drag.macroSource.index, drag.macroSource.slot);
      return result.ok;
    }
    return accepted;
  }

  placeKeyBinding(drag, target) {
    if (target > 90) return this.removeCarriedBinding(drag);
    return (
      target < 89 &&
      this.bindings.assign(target, drag.binding, drag.sourceIndex)
    );
  }

  /** 004f9386/004f38f4/004fb32c return the overwritten quick binding to 008d6409. */
  async placeQuickBinding(event, drag, target) {
    const epoch = this.epoch;
    const displaced = this.bindings.active.keys[target];
    const same =
      displaced.type === drag.binding.type && displaced.id === drag.binding.id;
    if (
      !(await this.bindings.assignQuick(target, drag.binding, drag.sourceIndex))
    ) {
      this.endBindingDrag();
      return false;
    }
    if (this.disposed || epoch !== this.epoch) return true;
    const visual = this.quickBindingVisual(displaced);
    if (!same && visual && this.bindings.canCarry(displaced)) {
      this.carryBinding(event, displaced, null, visual);
    }
    return true;
  }

  quickBindingVisual(binding) {
    const panel = this.hud.quickSurface;
    const action = binding.type >= 4 && binding.type <= 6;
    const source = action ? panel.keyLayer : panel.iconLayer;
    const template =
      binding.type === 1
        ? this.index.skills[binding.id]
        : binding.type === 8
          ? { iconPath: `SkillMacro/Macroicon/${binding.id}/icon` }
          : this.index.items[binding.id];
    const path = action ? `KeyConfig/icon/${binding.id}` : template?.iconPath;
    return source?.entities.has(path) ? { source, path } : null;
  }

  removeCarriedBinding(drag) {
    // Palette actions cannot be returned to the palette; existing keys/items/skills can.
    if (drag.palette) return false;
    const source =
      drag.sourceIndex ??
      this.bindings.active.keys.findIndex(
        (binding) =>
          binding.type === drag.binding.type && binding.id === drag.binding.id,
      );
    return source >= 0 && this.bindings.remove(source);
  }

  releaseBindingCapture(drag) {
    const capture = drag.capture;
    drag.capture = null;
    if (capture?.hasPointerCapture?.(drag.pointerId)) {
      capture.releasePointerCapture(drag.pointerId);
    }
  }

  syncBindingCarry() {
    const drag = this.bindingDrag;
    if (
      drag &&
      (drag.uid
        ? !carriedInstance(this, drag)
        : !this.bindings?.canCarry(drag.binding, drag.sourceIndex))
    ) {
      this.endBindingDrag();
    }
  }

  endBindingDrag() {
    const drag = this.bindingDrag;
    if (!drag) return;
    this.bindingDrag = null;
    this.releaseBindingCapture(drag);
    this.cursor?.release();
    this.cursor?.clearGhost();
    if (drag.source.retainedForDrag) drag.source.destroy();
  }
  /** Bounded diagnostics admission; notify:false prevents error-sound failure loops. Never forwards to onError. */
  recordError(error, { notify = true } = {}) {
    if (this.disposed) return false;
    return this.logs.record(error, notify);
  }

  report(error) {
    if (error?.name === "AbortError" || this.disposed) return;
    // Main's error hook records once, also covering non-UI and startup errors.
    this.hooks.onError(error);
  }

  snapshot() {
    return {
      ready: Boolean(this.index),
      visible: this.visible,
      authority: this.index?.authority || null,
      windows: Array.from(this.windows.keys()),
      pending: Array.from(this.pending.keys()),
      ...this.inputSnapshot(),
      status: this.lastStatus || null,
      focused: this.host.contains(document.activeElement),
      sprites:
        (this.hud?.sprites.length || 0) +
        Array.from(this.windows.values()).reduce(
          (sum, panel) => sum + panel.sprites.length,
          0,
        ),
      scale: this.scale,
      minimap: this.windows.get("MiniMap")?.mapId || null,
      layoutGeneration: this.layoutGeneration,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
      profile: this.store?.profile ? structuredClone(this.store.profile) : null,
      windowBounds: Array.from(this.windows.values(), (panel) => ({
        name: panel.name,
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
      })),
      originalTiming:
        "Only explicitly authored frame delays advance; missing timing is static/unsupported.",
    };
  }

  inputSnapshot() {
    return {
      chat: this.chat
        ? {
            state: this.chat.state,
            focused: document.activeElement === this.chat.input,
            historyCount: this.chat.history.length,
            channel: this.chat.selector.selectedIndex,
            height: this.chat.height,
            log: this.chat.messages.snapshot(),
          }
        : null,
      cursor: this.cursor?.current ?? null,
      draggingBinding: this.bindingDrag?.binding || null,
      keyBindings: this.bindings?.snapshot() || null,
      gaugeExtents: this.hud?.gauges?.map((gauge) => gauge.extent) || null,
    };
  }

  destroy() {
    if (this.disposed) return;
    settlePrompt(this, this.promptRequest, null);
    this.retireAllWindows();
    this.disposeOwnedSurfaces();
  }

  disposeOwnedSurfaces() {
    this.disposed = true;
    this.hideTooltip();
    this.prepareController?.abort();
    this.controller.abort();
    try {
      this.clearWindowPreloads();
      this.unsubscribeProfile?.();
      this.unsubscribeBindings?.();
      this.profileControls?.destroy();
      this.chat?.destroy();
      this.cursor?.destroy();
      this.temporaryStats?.destroy();
      this.notices?.destroy();
      this.logs.destroy();
      this.hud?.destroy();
      this.root.destroy({ children: true });
    } finally {
      this.stopObservingLayout();
      this.host.remove();
      this.stopListeningForInput();
      this.hooks.clearInput();
    }
  }

  stopObservingLayout() {
    this.layoutObserver?.disconnect();
    this.layoutMutations?.disconnect();
    if (this.layoutFrame !== null) cancelAnimationFrame(this.layoutFrame);
    window.removeEventListener("resize", this.layoutHandler);
    window.removeEventListener("scroll", this.layoutHandler, true);
  }

  stopListeningForInput() {
    window.removeEventListener("keydown", this.keyHandler, true);
    window.removeEventListener("keyup", this.keyUpHandler, true);
    window.removeEventListener("keydown", this.gameplayKeyHandler);
    window.removeEventListener("pointerdown", this.pointerHandler, true);
    window.removeEventListener("focusin", this.focusHandler, true);
    window.removeEventListener("pointermove", this.moveHandler, true);
    window.removeEventListener("pointerup", this.releaseHandler, true);
    window.removeEventListener("pointercancel", this.releaseHandler, true);
    window.removeEventListener("click", this.bindingClickHandler, true);
    window.removeEventListener("dblclick", this.bindingClickHandler, true);
    window.removeEventListener("dblclick", this.doubleClickHandler, true);
    window.removeEventListener("contextmenu", this.bindingClickHandler, true);
    window.removeEventListener("mousedown", this.bindingMouseHandler, true);
    window.removeEventListener("blur", this.releaseHandler);
    window.removeEventListener(
      "lostpointercapture",
      this.captureLostHandler,
      true,
    );
    document.removeEventListener("visibilitychange", this.releaseHandler);
  }
}
