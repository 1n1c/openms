# Mob 仇恨系统

## 现状（2026-10-25）

当前 mob 有两套**完全独立**的数据：

| 数据 | 谁写 | 何时写 | 给谁用 |
|---|---|---|---|
| `mob.damageCredit = Map<actorId, {actor, damage}>` | `recordKillDamage` via `hooks.onMobDamage` | 每次玩家攻击 mob | **仅** 击杀结算时算经验/掉宝归属 |
| `mob.aggro.damageInstances + expireStreak + ticksRemaining` | `admitMobAggro` via `damageMob` | 每次 mob 被击中就 +1 | 仅决定 mob "追还是巡逻" |

但 **target 选择** 用的是完全无关的第三个东西：`nearestTarget(field, mob)` —— 永远选欧几里得距离最近的玩家，不看 damageCredit，不看 mob.damageOwnerId。

### 结果

```
玩家 A 在 mob 左边 100px → 打 mob，damageCredit[A] += 30，aggro.damageInstances++
玩家 B 刷在 mob 右边 50px（更近，过路）

mob 行为：
  stepMob → aggro.damageInstances > 0 → chaseMob(target)
  target = nearestTarget() = B  ← 追路过的 B！
  A 继续打 → damageCredit[A] 持续增加 → 经验全归 A
  B 没打 mob 但被追着打，A 打了 mob 却不被追
```

## 伤害归属的完整链路（已确认）

```
OfflineField.damageTarget(target, amount, hit, facing)
  → target.damageOwnerId = actor.id     ← 最后一击归属者
  → damageMob(target, amount, facing, hit)
      → admitMobAggro(mob, amount)       ← 累积 aggro
      → mob.hp -= amount
  → hit.hpDamage = beforeHP - target.hp
  → recordMobDamage(target, hit.hpDamage)
      → hooks.onMobDamage?.(target, amount)
          → recordKillDamage(actor, mob, amount)
              → mob.damageCredit.set(actor.id, { actor, damage: amount })
```

`damageCredit` 有真实数据，每次玩家打 mob 都记一笔。

## 当前仇恨/目标选择逻辑

### admitMobAggro（offline-mobs.js:474-487）

```
跳过 aggro 的情况：
  - mob.movement === "stationary-special"（特殊固定怪）
  - (!mob.flight && mob.speed <= 0)（真固定怪）
  - mob.template.info.boss === true（BOSS！跳过 aggro，永远选最近）

正常情况：
  aggro.expireStreak = 0
  aggro.ticksRemaining = aggroExpiryTicks()
  aggro.damageInstances++
```

### aggro 衰减（offline-mobs.js:506-527）

```
stepMobAggro(mob, ms, target):
  每 5s（MOB_AGGRO.updateMs）检查一次：
    ticksRemaining--
    if ticksRemaining <= 0:
      expireStreak++
      ticksRemaining = aggroExpiryTicks()
      damageInstances--
  当 damageInstances 衰减到 0 → mob 回到巡逻

aggroExpiryTicks 是指数衰减：
  ticks = ceil(120000ms / 5000ms / 2^(expireStreak + damageInstances))
  → 刚开始 24 ticks，后面越来越快
```

### nearestTarget（field-combat.js:123-144）

```
遍历 field.characters.values()
跳过：hp<=0, !skillField, state!==active, retiring, deliveryError
选 √((actor.x - mob.x)² + (actor.y - mob.y)²) 最小的
→ 完全不看 damageCredit / aggro / damageOwnerId
```

### stepMob 的 target 传递（field-combat.js:207-212）

```
stepMob(mob, 30, target?.skillField.targetFor(mob) ?? null, mob.scheduledDamage)
  ↓
chaseMob(mob, ms, target) → target 是 skillField.targetFor(mob) 的返回值
```

mob.aggro 只决定 "追还是巡逻"，追谁由 nearestTarget 说了算。

## 关联方案

### 引入 selectMobTarget 替代 nearestTarget

```js
function selectMobTarget(field, mob) {
  // 1. 有伤害归属 → 追伤害贡献最高的玩家
  if (mob.aggro.damageInstances > 0) {
    const topContributor = mob.damageCredit?.size
      ? [...mob.damageCredit.values()].sort((a, b) => b.damage - a.damage)[0]
      : null;
    const preferred = topContributor?.actor
      ?? field.characters.get(mob.damageOwnerId);

    if (preferred && isEligible(preferred)) {
      return preferred;
    }
  }
  // 2. Fallback：最近玩家（初次吸引 / 仇恨归属者失效时）
  return nearestTarget(field, mob);
}
```

两处调用替换：
- `advanceSharedMob` → `selectMobTarget(field, mob)`
- `advanceMobAttack` → `selectMobTarget(field, mob)`

### BOSS 特殊处理

BOSS 在 `admitMobAggro` 里已经跳过了 aggro → `damageInstances` 永远为 0 → `selectMobTarget` 自然走到 fallback nearestTarget → BOSS 永远追最近的 → 保持围殴公平性。

### 还需补的点

| 点 | 现状 | 补什么 | 状态 |
|---|---|---|---|
| aggro 归零时 damageOwnerId 清空 | `stepMobAggro` 只衰减 `damageInstances` | 衰减到 0 时同步清空 `mob.damageOwnerId` | TODO |
| mob 死亡复活时 damageCredit 清空 | `creditGeneration` 变化 → `new Map()` | 已有 generation 保护 | ✅ 已 OK |
| 远程攻击权重 | 当前所有伤害等权 | 原版可能有远程/近战权重差异 | TODO 后期 |
| 仇恨值曲线 | 当前只有指数衰减 | 原版可能有积累阈值 / 距离衰减 | TODO 后期 |
| BOSS 特殊仇恨 | 当前 BOSS 跳过 aggro 永远最近 | 原版可能有 BOSS 专属仇恨逻辑 | TODO 后期 |

## 效果对比

| 维度 | 当前（脱节） | 关联后 |
|---|---|---|
| 两个玩家争怪 | mob 追最近的 B，经验归 A | mob 追伤害归属者 A，归属者反打形成锁定 |
| mob 被远程惊扰 | 路过者倒霉 | 真正打它的人被追，路过者安全 |
| BOSS 围殴 | 谁近追谁（公平） | 保持（BOSS 跳过 aggro） |
| 掉落归属 | 伤害最高的（和仇恨无关） | 伤害最高的通常也是仇恨目标 → 行为一致 |

## 相关文件

| 文件 | 作用 |
|---|---|
| `server/src/field-combat.js:123-144` | nearestTarget / selectMobTarget |
| `server/src/field-combat.js:195-215` | advanceSharedMob（调 nearestTarget） |
| `server/src/field-combat.js:258-261` | advanceMobAttack（调 nearestTarget） |
| `client/src/combat/offline-mobs.js:474-487` | admitMobAggro |
| `client/src/combat/offline-mobs.js:506-527` | stepMobAggro |
| `client/src/combat/offline-mobs.js:459-470` | stepGroundMob（aggro→chase） |
| `client/src/combat/offline-mobs.js:683-729` | damageMob（调 admitMobAggro） |
| `client/src/combat/offline-field.js:821-823` | recordMobDamage → hooks.onMobDamage |
| `server/src/skill-hooks.js:59` | onMobDamage → recordKillDamage |
| `server/src/kill-credit.js:10-22` | recordKillDamage（写 damageCredit） |
