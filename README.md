# H1Emu Loot DB

Interactive Tarkov-style item database for [h1z1-server](https://github.com/QuentinGruber/h1z1-server) / H1Emu. Search any item (e.g. `AR-15`) and see damage, fire rate, ammo, magazine size, loot spawn locations (with a Z1 map), crafting recipes, use effects, durability and repair — extracted from what the server actually does.

## Usage

Open [`index.html`](./index.html) in a browser. No web server needed — item data is bundled in `db.js`.

Or serve locally:

```bash
npx http-server . -p 8080 -c-1
```

## Regenerating the data

`extract.ts` must be run from inside a checkout of [h1z1-server](https://github.com/QuentinGruber/h1z1-server) (it imports server TypeScript and reads `data/2016/...`):

```bash
# from the h1z1-server repo root, with this folder at tools/loot-wiki/
npx tsx tools/loot-wiki/extract.ts
```

Then copy the regenerated files here (or keep this folder as `tools/loot-wiki` in that repo).

## Where the data comes from

| Wiki section | Source |
|---|---|
| Item names, classes, bulk, stack | `data/2016/dataSources/ServerItemDefinitions.json` |
| Descriptions | `data/2015/locale/en.json` (via `DESCRIPTION_ID`) |
| Magazine, fire rate, reload, range, ammo | `data/2016/dataSources/ServerWeaponDefinitions.json` |
| Gun damage | `getProjectileDamage()` in `zoneserver.ts` (parsed from source) |
| Headshot multipliers | `Character.OnProjectileHit()` (mirrored) |
| Melee damage | `abilitiesmanager.ts` melee switch (parsed from source) |
| Loot tables | `data/2016/lootTables/ground` + `containers` |
| World spawn points | `Z1_items.json` + `Z1_lootableProps.json` |
| Spawn map POIs | `Z1_POIs.json` |
| Zombie drops | `Npc.addZombieLoot()` (mirrored) |
| Recipes & smelting | `Recipes.ts` |
| Food/drink/medical effects | `useoptions.ts` |
| Durability & repair | `getItemBaseDurability()` / `repairOptionPass()` (mirrored) |

Plugin loot table overrides are **not** applied; the wiki reflects the base server data.
