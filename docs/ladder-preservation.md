# Ladder Preservation — Mob Contact Damage on Climbers

> **分支**: `pr/ladder`
> **Commit**: `3e53646`
> **日期**: 2026-10-17
> **改动**: 6 文件, +21 / -8

## 问题

原版 MapleStory 中，玩家爬绳梯时被怪物碰撞：
- 受到伤害
- 轻微水平抖动（击退被削弱）
- **不会被踢下绳梯**

openms 之前的实现：任何外部冲量（`applyExternalImpulse`）都会无条件清 `sim.ladderId = 0` —— 导致爬绳梯碰怪物直接掉下来。

## 根因：冲量被应用了 2~3 次

修复分两个阶段才完成，因为 mob contact 冲量在系统里**不是只走一条路径**：

### 第一次尝试失败 — 只改 client 侧

只在 client 侧 `offline-field.js::applyHitImpulse` 和 `local-hit-motion.js::begin()` 加了 `preserveLadder=true`。测试还是掉下来。

原因：server authoritative simulation 是独立运行的。client 侧改了不影响 server。

### 第二次尝试失败 — server 侧只改了一个入口

server 侧有**两个**地方消费 mob contact 冲量：

```
Server contactDamage()
  │
  ├─① applyHitImpulse(preserveLadder=true)          ← 第一次，本地门控 ✅
  │     └─ onExternalImpulse hook → recordMotionDivert
  │           └─ grantMovementImpulse 入 grant 队列
  │
  └─② applyMovementImpulses(grant)                  ← 第二次，grant 消费 ❌
        └─ applyExternalImpulse(sim, grant.vx, grant.vy)  ← 没 preserveLadder！
          └─ sim.ladderId = 0                         ← 终究被清了！
```

同一个 mob hit impulse 在 server 端被 apply 两次 —— 第一次 preserveLadder=true 保留了，第二次 grant 消费没 preserveLadder，终究清了 ladderId。

### 第三次尝试失败 — motion.fault NOT_ALLOWED

修了 server 两个 grant 入口后，服务器不再清 ladder。但又出现新问题 —— 每次 mob hit 后 30ms 触发 `motion.fault NOT_ALLOWED`，玩家被踢回登录界面。

根因链条：
```
Server authoritative sim.vx = -135  (grant 消费 preserveLadder=true → 半额 vx*0.5)
Client prediction sim.vx   = -270  (mergeImpulse 没 preserveLadder → 满额)
差值 135 → matchesEndpoint 失败 → faultMotion → NOT_ALLOWED!
```

client 侧 prediction.js 的 `mergeImpulse(divert.vx, divert.vy)` 在 server divert 发布回来时合并冲量，也需要 preserveLadder。

### 第四次 — 完整修复（通过）

**双端冲量链全部加上 preserveLadder**：

| 位置 | preserveLadder 来源 | 角色 |
|---|---|---|
| simulation.js::applyExternalImpulse | 参数 `preserveLadder = false` | **共享门控**（所有冲量汇聚到此） |
| offline-field.js::applyHitImpulse | 硬编码 `true` | Server/离线路径 mob contact |
| local-hit-motion.js::begin() | 硬编码 `true` | Client hit preview copy |
| movement-impulses.js::applyMovementImpulses | `grant.source === "hit"` | Server grant 消费 |
| movement-clock.js::settleDisconnectedMovement | `grant.source === "hit"` | 断线重连 replay |
| prediction.js::mergeImpulse | `divert.source === "hit"` | Client divert 合并 |

## 实现：preserveLadder 门控

在共享入口 `applyExternalImpulse` 最前面加门控：

```js
if (preserveLadder && sim.ladderId !== 0) {
  sim.vx = mergeImpulse(sim.vx, vx * 0.5); // 半额水平冲量
  sim.vy = 0;                               // 不垂直推
  updateAction(sim);
  return;                                   // 跳过后面的清 ladder 代码
}
```

原版（非 preserveLadder 路径）不动：
```js
sim.seat = null;
detachGround(sim);
sim.ladder = null;
sim.ladderId = 0;        // ← 这里清 ladder
sim.vx = mergeImpulse(sim.vx, vx);
sim.vy = mergeImpulse(sim.vy, vy);
```

## 行为矩阵（按冲量来源）

| 来源 | preserveLadder | 爬绳梯被击中 | 冲量矢量 |
|---|---|---|---|
| 怪物碰撞（mob contact） | ✅ true | 不掉下，只受伤 | vx×0.5, vy=0 |
| 弹射物命中玩家 | ❌ false | 掉下绳梯 | 满额 vx, vy |
| 环境伤害 | ❌ false | 掉下绳梯 | 满额 vx, vy |
| 技能击退 | ❌ false | 掉下绳梯 | 满额 vx, vy |

**preserveLadder 只给 mob contact（`grant.source === "hit"`）**。所有其他 knockback 类型走原路径，正常踢下绳梯。

## 排查 checklist —— 下次 ladder 相关改动

1. **所有冲量汇聚到 `applyExternalImpulse`** —— 先确认这个函数签名和门控逻辑
2. **server 有两次 apply** —— 本地 applyHitImpulse + grant 消费（movement-impulses.js + movement-clock.js）
3. **client 也有两次 apply** —— LocalHitMotion.begin copy + prediction.mergeImpulse divert 合并
4. **双端必须一致** —— server authoritative sim 和 client prediction sim 的 vx/vy 必须相同，否则 `matchesEndpoint` faultMotion
5. **冲量来源标识** —— `grant.source` 和 `divert.source` 是 `"hit"` 还是 `"skill"` 决定 preserveLadder 值

## 关键日志（调试时用）

在 `applyExternalImpulse` 里临时加的 debug log 已清理。如果下次再遇到 ladder 问题，可以临时加回：

```js
if (preserveLadder && sim.ladderId !== 0) console.error("[ladder] preserveLadder HIT vx=" + vx);
if (!preserveLadder && sim.ladderId !== 0) console.error("[ladder] preserveLadder SKIP vx=" + vx);
```

HIT + SKIP 交替出现 → 说明冲量被 apply 两次，第二次没 preserveLadder。

## 涉及文件

```
client/src/physics/simulation.js      applyExternalImpulse(preserveLadder) 共享门控
client/src/combat/offline-field.js    applyHitImpulse(..., true)           server/offline mob contact
client/src/online/local-hit-motion.js  begin(..., true)                     client hit preview copy
client/src/online/prediction.js        mergeImpulse(vx,vy,preserveLadder)   client divert 合并
server/src/movement-impulses.js        grant.source==="hit" → preserveLadder server grant 消费
server/src/movement-clock.js           同上                                 断线重连 replay
```
