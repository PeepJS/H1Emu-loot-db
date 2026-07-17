// ======================================================================
// Loot wiki data extractor.
//
// Builds tools/loot-wiki/db.js (window.LOOT_DB = ...) from the actual
// server data files and TypeScript sources so the wiki always reflects
// what the code really does.
//
// Run with:  npx tsx tools/loot-wiki/extract.ts
// ======================================================================

import * as fs from "fs";
import * as path from "path";

import {
  Items,
  WeaponDefinitionIds,
  FilterIds,
  ItemUseOptions,
  ItemClasses,
  ItemTypes,
  ModelIds,
  HealTypes
} from "../../src/servers/ZoneServer2016/models/enums";
import {
  recipes,
  smeltingData
} from "../../src/servers/ZoneServer2016/data/Recipes";
import { UseOptions } from "../../src/servers/ZoneServer2016/data/useoptions";

const ROOT = path.join(__dirname, "..", "..");
const DATA = path.join(ROOT, "data", "2016");
const SRC = path.join(ROOT, "src", "servers", "ZoneServer2016");

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

// ----------------------------------------------------------------------
// 1. Item definitions
// ----------------------------------------------------------------------
const itemDefs: Record<string, any> = readJson(
  path.join(DATA, "dataSources", "ServerItemDefinitions.json")
);

// 2015 locale is the only string table in the repo; many 2016 NAME_ID /
// DESCRIPTION_ID values still resolve through it.
const locale: Record<number, string> = {};
for (const entry of readJson(
  path.join(ROOT, "data", "2015", "locale", "en.json")
)) {
  if (entry.text && !entry.text.startsWith("[STRING")) {
    locale[entry.id] = entry.text;
  }
}

// ----------------------------------------------------------------------
// 2. Weapon definitions (clip size, fire rate, ammo, reload, range)
// ----------------------------------------------------------------------
const weaponJson = readJson(
  path.join(DATA, "dataSources", "ServerWeaponDefinitions.json")
);
const WEAPON_DEFS = weaponJson.WEAPON_DEFINITIONS;
const FIRE_GROUPS = weaponJson.FIRE_GROUP_DEFINITIONS;
const FIRE_MODES = weaponJson.FIRE_MODE_DEFINITIONS;

interface FireModeOut {
  ammoId: number;
  refireMs: number;
  rpm: number;
  reloadMs: number;
  range: number;
  pellets: number;
  burst: number;
}

function getWeaponStats(weaponDefId: number) {
  const def = WEAPON_DEFS[weaponDefId]?.DATA;
  if (!def) return null;
  const clipSize = def.AMMO_SLOTS?.[0]?.CLIP_SIZE ?? 0;
  const modes: FireModeOut[] = [];
  const seen = new Set<string>();
  for (const fg of def.FIRE_GROUPS ?? []) {
    const group = FIRE_GROUPS[fg.FIRE_GROUP_ID]?.DATA;
    if (!group) continue;
    for (const fm of group.FIRE_MODES ?? []) {
      const mode = FIRE_MODES[fm.FIRE_MODE_ID]?.DATA?.DATA;
      if (!mode) continue;
      const out: FireModeOut = {
        ammoId: mode.AMMO_ITEM_ID ?? 0,
        refireMs: mode.REFIRE_TIME_MS ?? 0,
        rpm: mode.REFIRE_TIME_MS
          ? Math.round(60000 / mode.REFIRE_TIME_MS)
          : 0,
        reloadMs: mode.RELOAD_TIME_MS ?? 0,
        range: mode.RANGE ?? 0,
        pellets: mode.PELLETS_PER_SHOT ?? 0,
        burst: mode.BURST_COUNT ?? 1
      };
      const key = JSON.stringify(out);
      if (!seen.has(key)) {
        seen.add(key);
        modes.push(out);
      }
    }
  }
  return { clipSize, modes };
}

// ----------------------------------------------------------------------
// 3. Projectile damage — parsed from getProjectileDamage() in zoneserver.ts
// ----------------------------------------------------------------------
type DamageOut =
  | { kind: "flat"; value: number }
  | {
      kind: "falloff";
      min: number;
      max: number;
      startM: number;
      endM: number;
    };

function parseProjectileDamage(): {
  byWeaponDef: Record<number, DamageOut>;
  fallback: number;
} {
  const src = readSrc("zoneserver.ts");
  const start = src.indexOf("getProjectileDamage(");
  const slice = src.slice(start, src.indexOf("validateHit("));
  const byWeaponDef: Record<number, DamageOut> = {};
  let fallback = 1000;

  const re =
    /case WeaponDefinitionIds\.(\w+):|return (\d+);|return calculate_falloff\(([\s\S]*?)\);|default:/g;
  let pending: string[] = [];
  let inDefault = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    if (m[0] === "default:") {
      inDefault = true;
      continue;
    }
    if (m[1]) {
      pending.push(m[1]);
      continue;
    }
    let dmg: DamageOut | null = null;
    if (m[2]) {
      dmg = { kind: "flat", value: parseInt(m[2]) };
    } else if (m[3]) {
      const args = m[3]
        .replace(/\/\/.*$/gm, "")
        .match(/(?<![\w.])\d+(?![\w(])/g)
        ?.map(Number);
      // calculate_falloff(distance, minDamage, maxDamage, falloffStart, falloffEnd)
      if (args && args.length >= 4) {
        dmg = {
          kind: "falloff",
          min: args[args.length - 4],
          max: args[args.length - 3],
          startM: args[args.length - 2],
          endM: args[args.length - 1]
        };
      }
    }
    if (dmg) {
      if (inDefault && dmg.kind === "flat") {
        fallback = dmg.value;
        inDefault = false;
      }
      for (const name of pending) {
        const id = (WeaponDefinitionIds as any)[name];
        if (id !== undefined) byWeaponDef[id] = dmg;
      }
      pending = [];
    }
  }
  return { byWeaponDef, fallback };
}
const projectileDamage = parseProjectileDamage();

// PvP hit modifiers, mirrored from Character.OnProjectileHit (character.ts):
// shotgun: headshot x2 / armor divisor 10; .308: headshot x6 / armor divisor 1;
// everything else: headshot x4 / armor divisor 4.
function getHitModifiers(weaponDefId: number) {
  switch (weaponDefId) {
    case WeaponDefinitionIds.WEAPON_SHOTGUN:
      return { headshotMultiplier: 2 };
    case WeaponDefinitionIds.WEAPON_308:
      return { headshotMultiplier: 6 };
    default:
      return { headshotMultiplier: 4 };
  }
}

// ----------------------------------------------------------------------
// 4. Melee damage — parsed from AbilitiesManager (abilitiesmanager.ts)
//    base 1000, per-weapon multiplier, x2 on head/neck.
// ----------------------------------------------------------------------
function parseMeleeDamage(): Record<number, number> {
  const src = readSrc(path.join("managers", "abilitiesmanager.ts"));
  const start = src.indexOf("const baseDamage = 1000;");
  const slice = src.slice(start, src.indexOf("abilityHitLocation", start));
  const out: Record<number, number> = {};
  const re = /case (?:Items)\.(\w+):|damage \*= (\d+);|break;/g;
  let pending: string[] = [];
  let mult: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    if (m[1]) {
      pending.push(m[1]);
    } else if (m[2]) {
      mult = parseInt(m[2]);
    } else {
      // break;
      if (mult !== null) {
        for (const name of pending) {
          const id = (Items as any)[name];
          if (id !== undefined) out[id] = 1000 * mult;
        }
      }
      pending = [];
      mult = null;
    }
  }
  return out;
}
const meleeDamage = parseMeleeDamage();

// ----------------------------------------------------------------------
// 5. Durability — mirror of ZoneServer2016.getItemBaseDurability()
// ----------------------------------------------------------------------
function isWeaponDef(d: any) {
  return d.ITEM_TYPE == ItemTypes.WEAPON;
}
function isGenericDef(d: any) {
  return d.ITEM_TYPE == 1;
}
function isConstructionDef(d: any) {
  return [40, 41].includes(d.ITEM_TYPE);
}
function isArmorDef(d: any) {
  return d.ITEM_CLASS == ItemClasses.BODY_ARMOR;
}
function isHelmetDef(d: any) {
  return d.ITEM_CLASS == 25000 && d.IS_ARMOR == 1;
}
function isConveyDef(d: any) {
  return d.DESCRIPTION_ID == 11895;
}
function getBaseDurability(d: any): number {
  const id = d.ID;
  switch (true) {
    case isGenericDef(d) && id == Items.SKINNING_KNIFE:
      return 2000;
    case isConstructionDef(d):
    case isGenericDef(d) && !isConveyDef(d):
      return 0;
    case id == Items.WEAPON_HATCHET_MAKESHIFT:
    case id == Items.WEAPON_BRANCH:
      return 500;
    case id == Items.WEAPON_BAT_ALUM:
      return 3000;
    case id == Items.WEAPON_AXE_WOOD:
    case id == Items.WEAPON_AXE_FIRE:
      return 4000;
    case id == Items.WEAPON_TORCH:
    case id == Items.WEAPON_COMBATKNIFE:
    case isArmorDef(d):
      return 1000;
    case isHelmetDef(d):
      return 100;
    case isConveyDef(d):
      return 5400;
    case isWeaponDef(d):
      return 2000;
    default:
      return 0;
  }
}

// ----------------------------------------------------------------------
// 6. Loot tables (ground + containers) and world spawn points
// ----------------------------------------------------------------------
function loadTables(sub: string): Record<string, any> {
  const dir = path.join(DATA, "lootTables", sub);
  const out: Record<string, any> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".json")) {
        const name = path
          .relative(dir, full)
          .slice(0, -5)
          .replace(/\\/g, "/");
        out[name] = readJson(full);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
const groundTables = loadTables("ground");
const containerTables = loadTables("containers");

// World ground spawn points, grouped by actorDefinition (= table name)
const positions: Record<string, number[]> = {};
const groundWorldCounts: Record<string, number> = {};
for (const group of readJson(path.join(DATA, "zoneData", "Z1_items.json"))) {
  const name = group.actorDefinition;
  if (!groundTables[name]) continue;
  groundWorldCounts[name] =
    (groundWorldCounts[name] ?? 0) + group.instances.length;
  const arr = (positions["g:" + name] ??= []);
  for (const inst of group.instances) {
    arr.push(Math.round(inst.position[0]), Math.round(inst.position[2]));
  }
}

// Container world spawn points: parse the actorModelId -> lootSpawner switch
// from lootableprop.ts, then match Z1_lootableProps by modelId.
function parseModelToSpawner(): Record<number, string> {
  const src = readSrc(path.join("entities", "lootableprop.ts"));
  const start = src.indexOf("switch (entity.actorModelId)");
  const slice = src.slice(start, src.indexOf("}\n}", start));
  const out: Record<number, string> = {};
  const re = /case ModelIds\.(\w+):|entity\.lootSpawner = "([\w/]+)";|break;/g;
  let pending: string[] = [];
  let spawner: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    if (m[1]) pending.push(m[1]);
    else if (m[2]) spawner = m[2];
    else {
      if (spawner) {
        for (const name of pending) {
          const id = (ModelIds as any)[name];
          if (id !== undefined) out[id] = spawner;
        }
      }
      pending = [];
      spawner = null;
    }
  }
  return out;
}
const modelToSpawner = parseModelToSpawner();

// Mirror of BaseLootableEntity.shouldSpawnLoot exclusions
const noLootModels = new Set<number>([
  ModelIds.HOSPITAL_LAB_WORKBENCH,
  ModelIds.TREASURE_CHEST,
  ModelIds.CAMPFIRE,
  ModelIds.FURNACE,
  ModelIds.HAND_SHOVEL
]);

const containerWorldCounts: Record<string, number> = {};
for (const group of readJson(
  path.join(DATA, "zoneData", "Z1_lootableProps.json")
)) {
  for (const inst of group.instances) {
    if (noLootModels.has(inst.modelId)) continue;
    const spawner = modelToSpawner[inst.modelId];
    if (!spawner || !containerTables[spawner]) continue;
    containerWorldCounts[spawner] = (containerWorldCounts[spawner] ?? 0) + 1;
    const arr = (positions["c:" + spawner] ??= []);
    arr.push(Math.round(inst.position[0]), Math.round(inst.position[2]));
  }
}

// Airdrop crate types (worldobjectmanager.ts createAirdrop)
const airdropTables = new Set([
  "Farmer",
  "Demolitioner",
  "Medic",
  "Builder",
  "Fighter",
  "Supplier"
]);

// ----------------------------------------------------------------------
// 7. Invert loot tables -> per-item sources
// ----------------------------------------------------------------------
interface Source {
  kind: "ground" | "container" | "airdrop" | "zombie";
  table: string;
  via?: string[];
  sharePct: number; // chance of this item when the pool/spawner rolls
  count: [number, number];
  rolls?: [number, number];
  conditions?: string[];
  spawnChance?: number; // ground only: % that spawn point is populated
  worldCount?: number;
  posKey?: string;
}
const sourcesByItem: Record<number, Source[]> = {};

function condText(c: any): string {
  switch (c.condition) {
    case "poi_tag":
      return `inside POI tagged: ${c.tags.join(", ")}`;
    case "not_poi_tag":
      return `outside POIs tagged: ${c.tags.join(", ")}`;
    case "in_poi":
      return `inside POI: ${(c.poi_names ?? c.poi_ids ?? []).join(", ")}`;
    case "not_in_poi":
      return "outside any POI";
    case "poi_names":
      return `inside POI: ${(c.poi_names ?? []).join(", ")}`;
    case "random_chance":
      return `${c.chance}% random chance`;
    case "elevation_range":
      return `elevation ${c.min ?? "-"} to ${c.max ?? "-"}`;
    case "item_density":
      return "limited by nearby item density";
    case "server_time":
      return `in-game hour ${c.hour_min ?? 0}-${c.hour_max ?? 23}`;
    default:
      return c.condition;
  }
}

// Expands a table's pools into per-item probability leaves.
// Returns entries: { itemId, share (0..1 within one draw), count, via, conds }
function expandTable(
  table: any,
  tables: Record<string, any>,
  via: string[],
  depth = 0
): {
  itemId: number;
  share: number;
  count: [number, number];
  via: string[];
  conds: string[];
  rolls?: [number, number];
}[] {
  if (!table || depth > 5) return [];
  const out: ReturnType<typeof expandTable> = [];
  for (const pool of table.pools ?? []) {
    const total = (pool.entries ?? []).reduce(
      (s: number, e: any) => s + (e.weight ?? 0),
      0
    );
    if (!total) continue;
    const conds = (pool.conditions ?? []).map(condText);
    const rolls: [number, number] | undefined = pool.rolls
      ? [pool.rolls.min, pool.rolls.max]
      : undefined;
    for (const entry of pool.entries ?? []) {
      const share = (entry.weight ?? 0) / total;
      const type = entry.type ?? "item";
      if (type === "empty") continue;
      if (type === "loot_table") {
        const sub = tables[entry.table] ?? groundTables[entry.table];
        for (const leaf of expandTable(
          sub,
          tables,
          [...via, entry.table],
          depth + 1
        )) {
          out.push({
            ...leaf,
            share: share * leaf.share,
            conds: [...conds, ...leaf.conds],
            rolls: rolls ?? leaf.rolls
          });
        }
        continue;
      }
      if (entry.item === undefined) continue;
      out.push({
        itemId: entry.item,
        share,
        count: entry.count ? [entry.count.min, entry.count.max] : [1, 1],
        via,
        conds,
        rolls
      });
    }
  }
  return out;
}

for (const [name, table] of Object.entries(groundTables)) {
  for (const leaf of expandTable(table, groundTables, [])) {
    (sourcesByItem[leaf.itemId] ??= []).push({
      kind: "ground",
      table: name,
      via: leaf.via.length ? leaf.via : undefined,
      sharePct: +(leaf.share * 100).toFixed(2),
      count: leaf.count,
      conditions: leaf.conds.length ? leaf.conds : undefined,
      spawnChance: table.spawnChance,
      worldCount: groundWorldCounts[name] ?? 0,
      posKey: positions["g:" + name] ? "g:" + name : undefined
    });
  }
}

for (const [name, table] of Object.entries(containerTables)) {
  if (name.startsWith("sub/")) continue; // reached via parent tables
  const isAirdrop = airdropTables.has(name);
  for (const leaf of expandTable(table, containerTables, [])) {
    (sourcesByItem[leaf.itemId] ??= []).push({
      kind: isAirdrop ? "airdrop" : "container",
      table: name,
      via: leaf.via.length ? leaf.via : undefined,
      sharePct: +(leaf.share * 100).toFixed(2),
      count: leaf.count,
      rolls: leaf.rolls,
      conditions: leaf.conds.length ? leaf.conds : undefined,
      worldCount: containerWorldCounts[name],
      posKey: positions["c:" + name] ? "c:" + name : undefined
    });
  }
}

// Zombie drops, mirrored from Npc.addZombieLoot (npc.ts).
// chance(n) means n/10 percent.
function addZombieSource(
  itemNames: (keyof typeof Items)[],
  chancePct: number,
  draws: number,
  count: [number, number]
) {
  for (const n of itemNames) {
    const id = Items[n];
    (sourcesByItem[id] ??= []).push({
      kind: "zombie",
      table: `Zombie kill — ${chancePct}% chance, ${draws} random draw${draws > 1 ? "s" : ""} from ${itemNames.length} items`,
      sharePct: +((chancePct / itemNames.length) * draws).toFixed(2),
      count
    });
  }
}
addZombieSource(
  [
    "WORN_LETTER_CHURCH_PV",
    "WORN_LETTER_LJ_PV",
    "WORN_LETTER_MISTY_DAM",
    "WORN_LETTER_RADIO",
    "WORN_LETTER_RUBY_LAKE",
    "WORN_LETTER_TOXIC_LAKE",
    "WORN_LETTER_VILLAS",
    "WORN_LETTER_WATER_TOWER"
  ],
  5,
  1,
  [1, 1]
);
addZombieSource(["AMMO_12GA", "AMMO_223", "AMMO_308", "AMMO_762"], 5, 2, [
  1, 3
]);
addZombieSource(["AMMO_380", "AMMO_9MM", "AMMO_45"], 10, 2, [1, 5]);
addZombieSource(
  ["WEAPON_BOW_MAKESHIFT", "BACKPACK_BLUE_ORANGE", "CRUMPLED_NOTE", "REFRIGERATOR_NOTE"],
  15,
  3,
  [1, 1]
);
addZombieSource(
  ["PROTOTYPE_MECHANISM", "PROTOTYPE_RECEIVER", "PROTOTYPE_TRIGGER_ASSEMBLY"],
  1,
  1,
  [1, 1]
);
addZombieSource(["CLOTH"], 80, 1, [1, 3]);

// ----------------------------------------------------------------------
// 8. Recipes / smelting
// ----------------------------------------------------------------------
interface RecipeOut {
  output: number;
  bundle?: number;
  filter: string;
  components: { id: number; amount: number }[];
  workbench?: boolean;
  weaponWorkbench?: boolean;
  leftOver?: number[];
  kind: "craft" | "smelt";
}
const recipeList: RecipeOut[] = [];
for (const [outId, r] of Object.entries(recipes) as [string, any][]) {
  recipeList.push({
    output: parseInt(outId),
    bundle: r.bundleCount,
    filter: FilterIds[r.filterId] ?? String(r.filterId),
    components: (r.components ?? []).map((c: any) => ({
      id: c.itemDefinitionId,
      amount: c.requiredAmount ?? 1
    })),
    workbench: r.requireWorkbench || undefined,
    weaponWorkbench: r.requireWeaponWorkbench || undefined,
    leftOver: r.leftOverItems?.length ? r.leftOverItems : undefined,
    kind: "craft"
  });
}
for (const r of Object.values(smeltingData) as any[]) {
  recipeList.push({
    output: r.rewardId,
    filter: FilterIds[r.filterId] ?? String(r.filterId),
    components: (r.components ?? []).map((c: any) => ({
      id: c.itemDefinitionId,
      amount: c.requiredAmount ?? 1
    })),
    kind: "smelt"
  });
}

// ----------------------------------------------------------------------
// 9. Use options (food / drink / medical / repair ...)
// ----------------------------------------------------------------------
const useByItem: Record<number, any[]> = {};
for (const u of Object.values(UseOptions) as any[]) {
  (useByItem[u.itemDef] ??= []).push({
    type: ItemUseOptions[u.type] ?? String(u.type),
    timeout: u.timeout,
    eat: u.eatCount,
    drink: u.drinkCount,
    comfort: u.comfortCount,
    heal: u.healCount,
    bandaging: u.bandagingCount,
    healType: u.healType !== undefined ? HealTypes[u.healType] : undefined,
    givetrash: u.givetrash || undefined
  });
}

// ----------------------------------------------------------------------
// 10. Assemble items
// ----------------------------------------------------------------------
// Items participating in crafting (helps classify raw materials)
const craftingItemIds = new Set<number>();
for (const r of Object.values(recipes) as any[]) {
  for (const c of r.components ?? []) craftingItemIds.add(c.itemDefinitionId);
}
for (const r of Object.values(smeltingData) as any[]) {
  for (const c of r.components ?? []) craftingItemIds.add(c.itemDefinitionId);
}

function categorize(d: any, id: number): string {
  const cls = d.ITEM_CLASS;
  const name: string = d.NAME ?? "";
  const code: string = typeof (Items as any)[id] === "string" ? (Items as any)[id] : "";
  const factory: string = d.CODE_FACTORY_NAME ?? "";
  if (d.ITEM_TYPE == ItemTypes.WEAPON) {
    return meleeDamage[id] !== undefined ||
      !getWeaponStats(d.PARAM1)?.modes?.some((m) => m.ammoId)
      ? "Melee"
      : "Guns";
  }
  if (code.startsWith("AMMO_") || factory === "Ammo" || cls == 25037)
    return "Ammo";
  if (useByItem[id]?.some((u) => u.type === "USE_MEDICAL" || u.heal || u.bandaging))
    return "Medical";
  if (useByItem[id]?.some((u) => u.type === "EAT" || u.type === "DRINK"))
    return "Food & Drink";
  if (isArmorDef(d) || isHelmetDef(d)) return "Armor";
  if (factory === "EmoteAnimation") return "Emotes";
  if (
    ["RewardCrate", "RewardCrateKey", "LockedRewardCrate"].includes(factory)
  )
    return "Crates & Keys";
  if (factory === "AccountRecipe") return "Skins & Unlocks";
  if (
    d.ITEM_TYPE == 36 ||
    d.ITEM_TYPE == 39 ||
    cls == ItemClasses.FOOTWEAR ||
    factory === "InfantryCosmetic"
  )
    return "Clothing";
  if (d.ITEM_TYPE == ItemTypes.CONTAINER || code.startsWith("CONTAINER"))
    return "Containers";
  if ([40, 41].includes(d.ITEM_TYPE)) return "Construction";
  if (code.includes("REPAIR") || name.toLowerCase().includes("repair kit"))
    return "Repair";
  if (craftingItemIds.has(id) || (recipes as any)[id]) return "Materials";
  return "Other";
}

const items: any[] = [];
for (const d of Object.values(itemDefs) as any[]) {
  const id = d.ID;
  if (!id || !d.NAME) continue;
  const codeName = (Items as any)[id];
  const item: any = {
    id,
    name: d.NAME,
    code: typeof codeName === "string" ? codeName : undefined,
    desc: locale[d.DESCRIPTION_ID],
    cat: categorize(d, id),
    cls: ItemClasses[d.ITEM_CLASS],
    stack: d.MAX_STACK_SIZE,
    bulk: d.BULK || undefined,
    rarity: d.RARITY || undefined,
    model: d.MODEL_NAME || undefined
  };

  // Weapon stats
  if (isWeaponDef(d) && d.PARAM1) {
    const stats = getWeaponStats(d.PARAM1);
    const dmg = projectileDamage.byWeaponDef[d.PARAM1];
    const hasAmmo = stats?.modes?.some((m) => m.ammoId);
    if (stats && hasAmmo) {
      item.weapon = {
        defName: WeaponDefinitionIds[d.PARAM1],
        clipSize: stats.clipSize,
        modes: stats.modes.filter((m) => m.ammoId),
        damage: dmg ?? { kind: "flat", value: projectileDamage.fallback },
        ...getHitModifiers(d.PARAM1)
      };
    }
  }

  // Melee stats
  if (meleeDamage[id] !== undefined) {
    item.melee = { damage: meleeDamage[id], headshotMultiplier: 2 };
  } else if (
    isWeaponDef(d) &&
    !item.weapon &&
    getBaseDurability(d) > 0
  ) {
    // any other equippable weapon swings for base melee damage
    item.melee = { damage: 1000, headshotMultiplier: 2 };
  }

  const dura = getBaseDurability(d);
  if (dura) item.durability = dura;

  if (useByItem[id]) item.use = useByItem[id];
  if (sourcesByItem[id]?.length) {
    item.sources = sourcesByItem[id].sort((a, b) => b.sharePct - a.sharePct);
  }

  items.push(item);
}
const byId = new Map(items.map((i) => [i.id, i]));

// Crafting cross-links
for (const r of recipeList) {
  const out = byId.get(r.output);
  if (out) (out.craftedBy ??= []).push(r);
  for (const c of r.components) {
    const comp = byId.get(c.id);
    if (comp) {
      (comp.usedIn ??= new Set()).add(r.output);
    }
  }
}
for (const item of items) {
  if (item.usedIn) item.usedIn = [...item.usedIn];
}

// Ammo <-> weapon cross-links
for (const item of items) {
  if (!item.weapon) continue;
  for (const mode of item.weapon.modes) {
    const ammo = byId.get(mode.ammoId);
    if (ammo) {
      (ammo.ammoFor ??= []).includes(item.id) || ammo.ammoFor.push(item.id);
    }
  }
}

// Repair info, mirrored from repairOption/repairOptionPass in zoneserver.ts:
// weapon repair kit restores up to +500 durability, gun repair kit restores
// the weapon to full (2000).
for (const item of items) {
  if (item.weapon && item.durability) {
    item.repair = [
      { id: Items.WEAPON_REPAIR_KIT, effect: "+500 durability" },
      { id: Items.GUN_REPAIR_KIT, effect: "full repair (2000)" }
    ];
  }
}

// ----------------------------------------------------------------------
// 11. POIs for the spawn map (bounds + labels)
// ----------------------------------------------------------------------
const pois = readJson(path.join(DATA, "zoneData", "Z1_POIs.json")).map(
  (p: any) => ({
    id: p.POIid,
    name: p.POIname,
    tags: p.tags ?? [],
    // bounds are arrays of polygons; each vertex is [x, z]
    bounds: (p.bounds ?? []).map((poly: number[][]) =>
      poly.flatMap((v) => [Math.round(v[0]), Math.round(v[1])])
    ),
    x: Math.round(p.position?.[0] ?? 0),
    z: Math.round(p.position?.[2] ?? 0)
  })
);

// ----------------------------------------------------------------------
// 12. Emit
// ----------------------------------------------------------------------
const db = {
  meta: {
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    playerMaxHealth: 10000,
    mapExtent: 4096,
    sources: {
      itemDefinitions: "data/2016/dataSources/ServerItemDefinitions.json",
      weaponDefinitions: "data/2016/dataSources/ServerWeaponDefinitions.json",
      lootTables: "data/2016/lootTables/",
      worldSpawns: "data/2016/zoneData/Z1_items.json + Z1_lootableProps.json",
      pois: "data/2016/zoneData/Z1_POIs.json",
      recipes: "src/servers/ZoneServer2016/data/Recipes.ts",
      useOptions: "src/servers/ZoneServer2016/data/useoptions.ts",
      damage:
        "src/servers/ZoneServer2016/zoneserver.ts getProjectileDamage() + abilitiesmanager.ts"
    }
  },
  items,
  positions,
  pois
};

const outPath = path.join(__dirname, "db.js");
fs.writeFileSync(
  outPath,
  "// Generated by tools/loot-wiki/extract.ts — do not edit.\n" +
    "window.LOOT_DB = " +
    JSON.stringify(db) +
    ";\n"
);
const kb = Math.round(fs.statSync(outPath).size / 1024);
console.log(
  `Wrote ${outPath} (${kb} KB): ${items.length} items, ` +
    `${Object.keys(groundTables).length} ground tables, ` +
    `${Object.keys(containerTables).length} container tables, ` +
    `${recipeList.length} recipes, ${Object.keys(positions).length} position groups`
);
