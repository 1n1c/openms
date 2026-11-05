# 服务器-客户端不同步根因分析与修复计划

> 日期：2026-10-17 → 2026-10-19 更新
> 分支：`pr/srv-cli-sync` → `pr/srv-cli-sync2`（已合并 Phase 1-5 + 趴下攻击闪断修复）
> 关联代码：`server/src/field-combat.js`, `server/src/combat-controller.js`, `client/src/physics/simulation.js`, `client/src/combat/offline-field.js`, `client/src/online/local-incoming.js`, `client/src/online/local-hits.js`, `client/src/online/local-combat.js`, `client/src/online/scene-events.js`, `client/src/online/ui.js`, `shared/combat-protocol.js`

---

## 1. 用户报告的三个核心问题

| # | 现象 | 期望行为 |
|---|------|---------|
| 1 | 一次攻击范围内给多只怪物显示伤害数字，但实际只有一只真实受到伤害 | 伤害数字只显示在服务器确认命中的目标上 |
| 2 | 一次受伤期间（无敌/miss 窗口期）出现二次伤害显示 | 同一 hit window 内只渲染一次伤害反馈，无敌期间不显示 |
| 3 | 怪物/玩家瞬移漂移；受击弹飞过程中再次被弹飞；跳上平台受伤后被弹下，1 秒后又漂移回平台上方 | 击退只应用一次，平台碰撞两端物理一致 |

---

## 2. 架构差距：为什么原版能做到而 openms 还不行

### 原版 MapleStory 客户端的 "0 延迟" 机制

原版 C++ 客户端有**完整的本地 field 模拟能力**：

| 能力 | 原版 | openms | 差距根源 |
|------|------|--------|---------|
| 客户端 mob AI | ✅ 完整行为树 | ❌ 仅渲染服务器推的 `mobState` | 客户端看到 mob 攻击帧已滞后 1 RTT |
| RNG 同步 | ✅ 同种子 / 确定性输入序列 | ❌ 客户端 `Math.random()` vs 服务器 `crypto.randomFillSync` | 同一碰撞两端独立掷骰子，判定必然分歧 |
| 伤害预判精度 | ✅ 客户端能独立算出正确 hit/miss/damage | ⚠️ 预判值来自独立 RNG，仅作占位 | 预判与权威不一致 → consume 失败 → 重复渲染 |
| 回退补偿 | ✅ 原生支持冲突修正 | ⚠️ 仅玩家→mob 有 `lagRewindTicks` | mob→玩家方向无补偿机制 |

**核心原则**：客户端有能力独立算出正确结果 → 无需等服务器。服务器事后校验即可。

### openms 当前的设计

openms 选择了 **"服务器权威 + 客户端乐观预判 + 权威回写"** 架构：

```
客户端输入 → 本地预判渲染 → 等待服务器 impact → consume 本地预判（跳过权威渲染）
                                               ↓
                                          服务器决定最终结果
```

这套架构本身没问题，但实现时有三个关键缺陷导致了上述所有症状。

---

## 3. 根因分析

### 根因 A：客户端与服务器独立掷骰子 → RNG 分裂

`PhysicalDamage.receive()` 被两端各自调用：

```
客户端 LocalIncoming.resolve() → roll() → Math.random → 预判 hit (damage=120)
服务器 admitIncomingHit()      → roll() → crypto      → 判定 dodge (damage=0)
```

两端都调用 `PhysicalDamage.evades()`（`physical-damage.js:94-103`）用各自 RNG 计算闪避概率。因为随机源不同，**客户端预判命中但服务端判定闪避**（或反之）是必然发生的常态。

### 根因 B：LocalIncoming.consume() 符号匹配过严

文件：`client/src/online/local-incoming.js:327-333`

```javascript
consume(event) {
    // ...
    return (
        this.now() - prediction.at <= PREDICTION_TTL_MS &&
        event.damage > 0 === prediction.damage > 0  // ← 必须 hit/miss 方向完全一致
    );
}
```

当客户端预判 hit（`prediction.damage = 120 > 0`）但服务端 impact 是 miss（`event.damage = 0`）时，返回 `false` → 事件**没被消费**。接下来 `scene-events.js:146-156` 走权威渲染路径，又画了一个数字 → **同一 hit 显示两次伤害数字**。

### 根因 C：LocalIncoming pending queue 匹配粒度不足

文件：`client/src/online/local-incoming.js:251-260`

pending queue 只用 `sourceId`（mob template ID）做 key，多个 pending 用 FIFO 顺序匹配。同一 mob 连续两次攻击时：
- 第一次因 RNG 不匹配没被 consume，queue 里还留着它
- 第二次 impact 到来时错误匹配到第一次的 prediction
- 又失败 → 多米诺骨牌式连续消费失败

服务端协议中已有唯一标识 `incomingId`（`skill-hooks.js:226` → `actionId: hit.incomingId ?? ...`），但客户端 `LocalIncoming.consume()` 完全没用它。

### 根因 D：contactDamage 多 mob 循环不检查 hitTimerMs

文件：`client/src/combat/offline-field.js:959-969`

```javascript
contactDamage() {
    for (const mob of this.mobs) {
        if (/* sweptBody 与玩家重叠 */) {
            if (this.proposeMobHit(mob, false)) return;  // 只有返回 true 才退出循环
        }
    }
}
```

当 Mob A 的 `proposeMobHit` 被 `rejectsHit` 拒绝（比如被 skillDefenses.protects 挡住，还没到 hitTimerMs 检查就提前返回 `accepted=false`），此时 `hitTimerMs` **尚未被设置**（`commitHitOutcome` 对 `accepted=false` 的 outcome 不执行 `applyHitPresentation`）。循环继续下一个 mob → **Mob B 在同一 tick 可以成功触发 incoming**。

这就是"一次碰撞期间多次伤害"的**服务端真正根因**：hitTimerMs 尚未建立前，多 mob 循环不做拦截。

### 根因 E：LocalHits 本地预判渲染范围过宽

文件：`client/src/online/local-hits.js:presentResolved()` + `present()`

客户端在攻击释放帧对**攻击范围内所有 mob** 都渲染了伤害数字（本地预判），但服务端通过 lagRewindTicks 校验后可能只确认了**部分**目标（甚至零个）。被拒绝的目标上的预判数字不会被 consume（因为服务器根本没发 impact 事件）→ **假伤害数字留在画面上**。

### 根因 F：击退 impulse 两端独立应用

文件：`offline-field.js` 的 `receiveHitImpulse` / `applyHitImpulse` 被两端各自执行：

- 客户端本地预判弹飞（`LocalIncoming.feedback()` → `motion.begin()`）
- 服务器 impact 到达时通过 `publishIncoming` 再触发一次击退

如果客户端预判和服务器权威 impulse 方向/强度不一致，会出现：
1. **二次弹飞**：客户端先推了一次，服务器又推一次
2. **平台漂移**：被弹下平台后，服务器物理模拟又把角色拉回平台上方

---

## 4. 根因层次图

```
用户症状
├── 问题1：一次攻击给多只怪显示假伤害
│   └── 根因E: LocalHits 在 release 帧渲染所有范围内 mob，不管服务器确认了多少
│
├── 问题2：一次受伤期间二次伤害显示
│   ├── 根因B: LocalIncoming.consume 的 damage>0 符号匹配过严
│   │   └── 根因A: 客户端/服务端 PhysicalDamage.receive 用独立 RNG
│   ├── 根因C: pending queue 仅用 mob.id + FIFO，无 attack 实例级唯一标识
│   └── 根因D: contactDamage 多 mob 循环在 hitTimerMs 设置前可触发多次
│
└── 问题3：位移漂移/二次弹飞
    └── 根因F: 击退 impulse 两端独立应用，方向/强度可能不一致
```

---

## 5. 修复计划

### 优先级排序

| 优先级 | 问题 | 修复思路 | 预计改动范围 |
|--------|------|---------|-------------|
| **P0** | 问题2 | **consume 逻辑：只要 pending 存在就消费，不要求符号匹配**。权威 impact 到达时无条件跳过本地预判数字。服务端永远正确。 | `local-incoming.js:315-334` 一行改动；`local-hits.js:446-458` 同步 |
| **P0** | 问题1 | **LocalHits 本地预判不再渲染伤害数字**，只做位置/动画预判。伤害数字只等服务器 impact 确认后渲染。 | `local-hits.js:138-160 presentResolved` 逻辑收缩 |
| **P1** | 根因D（服务端） | `contactDamage()` 循环前检查 `hitTimerMs !== 0`，非零则直接 return 跳过整个循环 | `offline-field.js:959-969` 加一行守卫 |
| **P1** | 根因F（击退重复） | 客户端本地预判击退只做视觉提示（motion.begin），不执行实际 physics impulse；真正击退等服务器 impact 后由权威数据驱动 | `local-incoming.js:feedback()` 移除或拆分 |
| **P2** | 根因C（匹配粒度） | pending queue 增加 `attackAction` 维度匹配；利用 `actionId`（服务端 impact 已带）做唯一标识 | `local-incoming.js:251-260` |
| **P2** | RNG 分裂（长期） | 路线 A：服务器在 mob 攻击开始时预计算 hit/miss/damage，随 mobState 一起广播。客户端直接使用预计算值。 | `field-combat.js:advanceMobAttack` + `mobCombatFields` schema 扩展 |

### 修复后预期效果

| 问题 | 修复前 | 修复后 |
|------|--------|--------|
| 问题1 | 范围 5 只怪显示数字，实际 1 只受伤 | 数字只出现在服务器确认的目标上 |
| 问题2 | 同一次 hit window 出现 2-3 个伤害数字 | 同一 hit window 只渲染一次反馈 |
| 问题3 | 弹飞后再次被推；被弹下平台后漂移回来 | 击退只应用一次；平台碰撞一致 |

---

## 6. 长期架构建议

openms 不必完整复刻原版的客户端 field 模拟（工程量巨大），但应该消除 **"两端独立计算同一问题"** 的模式。推荐路线：

### 路线 A：服务器预下发攻击结果（性价比最高）

服务器在 mob 攻击开始时（`beginSharedMobAttack`）就做一次预判计算，把 `hit/miss + damage` 作为预计算结果随 mobState 广播。客户端在 release 帧直接使用预计算值，不做独立 RNG 判定。

- 改动集中：`mobState` schema 扩展 + `LocalIncoming` 改为消费预下发数据
- 判定永远一致（服务器是权威源）
- 客户端无需 mob AI 能力

### 路线 B：接受部分延迟 + 视觉修正（当前可接受的妥协）

放弃"完全 0 延迟"，接受 mob→玩家方向有 ~1 RTT 延迟。通过以下手段补偿观感：
- 攻击释放帧客户端显示**占位视觉反馈**（比如闪白 + 击退预演），不提前弹伤害数字
- 服务器 impact 到达时渲染权威数字，如果和预判不同则平滑修正（淡出占位 + 弹出正确值）
- 这是 League of Legends 等现代 MOBA 的成熟方案

---

## 7. 关键文件索引

| 文件 | 职责 | 当前问题 |
|------|------|---------|
| `shared/combat-protocol.js` | combatState / combat.impact schema | 缺少 mob attack damagePreview 字段 |
| `server/src/field-combat.js` | field 主循环：advanceSharedMob → advanceMobAttack → finishActor | authored attack 入队时无 rejectsHit 前置；contactDamage 多 mob 无 hitTimerMs 守卫 |
| `server/src/combat-controller.js` | AuthorityCombat 基类；incoming 队列调度 | acceptsIncoming 无 hitTimerMs 前置 |
| `server/src/skill-hooks.js` | combat.impact / playerHit 事件广播 | impact 频率（每次攻击发几条 impact）需与客户端 consume queue 对齐 |
| `client/src/combat/offline-field.js` | OfflineField 基类；两端共享 | contactDamage 循环无 hitTimerMs 守卫；rejectsHit 只对 locallyInitiated 检查 hitTimerMs |
| `client/src/combat/physical-damage.js` | 伤害公式 + 闪避判定 | 两端独立 RNG → 判定必然分歧 |
| `client/src/online/local-incoming.js` | mob→玩家 本地预判 + consume | consume 符号匹配过严；pending queue 粒度不足；击退两端独立应用 |
| `client/src/online/local-hits.js` | 玩家→mob 本地预判 + consume | presentResolved 对范围内所有 mob 渲染数字；consume 可能有同样符号问题 |
| `client/src/online/scene-events.js` | 服务器事件接收 + consumeImpact 闸门 | consume 失败后走权威渲染 → 二次数字 |
| `client/src/online/local-combat.js` | 本地战斗总调度；consumeImpact WeakMap 缓存 | 缓存机制本身没问题，问题在于 consume 返回值 |

---

## 8. 趴下攻击闪断 "pop up" glitch 修复（2026-10-19, commit `4d23fb7`）

### 现象

按住↓趴下 → 攻击 → 攻击完毕瞬间闪 1 帧站起来再趴下。松开↓中途攻击时更严重：趴下攻击动画没播完就切成站立攻击姿态。

### 根因链

```
combat 攻击开始
  → actor.attackState.active = true → movementLocked = true
  → simulation.step() 清除 sim.verticalInput = 0（因为 movementLocked）
  → 原代码：sim.crouching = !sim.movementLocked && input.down && horizontal === 0
                         = false && ... = false     ← 💥 趴姿丢失！
  → updateAction(): sim.crouching=false, horizontal=0 → sim.action = 'stand1'
  → drawSelfPose: local.current() 还有效 → chosen=local.action='proneStab' ✅ 掩盖问题

攻击结束瞬间
  → local.current() 过期 → localAction = null
  → owns()=true（match 还能找到未 prune 的 record）→ 进入 simulation fallback
  → chosen = sim.action = 'stand1'                  ← 💥 闪断！
  → 下一帧 movementLock 解锁 + 松手 → crouching 恢复 → sim.action='prone' ✅
```

### 修复

**[client/src/physics/simulation.js:343-345](file:///f:/openms/client/src/physics/simulation.js#L343-L345)** — movementLocked 期间保留之前的 crouching 值：

```diff
- sim.crouching =
-   !sim.movementLocked &&
-   sim.state === "ground" &&
-   input.down &&
-   horizontal === 0;
+ sim.crouching = sim.movementLocked
+   ? sim.crouching
+   : sim.state === "ground" && input.down && horizontal === 0;
```

这样 `updateAction()` 在整个攻击期间保持 `sim.action = 'prone'` / `'sit'`，drawSelfPose fallback 选到正确姿势。只有当 movementLock 解锁且玩家实际松开↓时，crouching 才自然变为 false → 平滑站起。

### 为什么 drawSelfPose 层补丁无效

`MOVEMENT_ACTIONS` Set 包含 `"prone"` 和 `"sit"`，试图用 `!MOVEMENT_ACTIONS.has(action)` 过滤 sim 的 stand1 残留时，对 prone/sit 场景返回 false → 补丁永远不触发。

### 验证

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 按住↓ → 攻击 → 等结束 | 攻击结束闪 1 帧 stand1 → prone | 全程 proneStab → prone，无闪断 |
| 按住↓ → 攻击 → 中途松开↓ | 攻击未结束就切成站立攻击姿态 | proneStab 完整播放 → 结束后自然站起 |
| 站立 → 攻击 | 正常 | 正常（不受影响） |
| 走路 → 攻击 | 正常 | 正常（不受影响） |
