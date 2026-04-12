# Viron — Architecture Reference

> **Purpose:** Orientation document for LLM editors and new contributors.  
> The codebase uses plain HTML/JS with p5.js in global mode — no ES modules,  
> no bundler, no TypeScript. All files share one global browser namespace.  
> The `<script>` load order in `index.html` IS the dependency system.

---

## 1. Runtime Stack

| Layer | Technology |
|-------|-----------|
| Canvas | WebGL via `createCanvas(w, h, WEBGL)` (p5.js 5.x) |
| Audio | Web Audio API wrapped in `GameSFX` class (`sfx.js`) |
| Physics | Custom rigid-body routines in `PhysicsEngine.js` |
| Entry point | `sketch.js` — exports p5 lifecycle hooks `preload`, `setup`, `draw` |
| Packaging | PWA (service worker `sw.js`, manifest `manifest.json`) |
| Tests | Puppeteer headless-Chromium smoke test (`npm test`) — 6 s, checks for WebGL/JS errors |

---

## 2. Script Load Order (Dependency Contract)

Scripts are loaded in `index.html` in this exact order. **Do not move a script above any file it `@requires`.**

| Layer | File(s) | Key Exports |
|-------|---------|-------------|
| 0 | *(p5.min.js, p5.sound.min.js — loaded in `<head>`)* | p5 global, `loadSound` |
| 1 — Foundation | `utils.js` | `findNearest` |
| 1 — Foundation | `constants.js` | All game constants, `TileManager`, `infection`, `updateTimeOfDay` |
| 2 — Assets | `shipDesigns.js` | `SHIP_DESIGNS` |
| 3 — Audio | `sfxTunes.js` | `SFX_LEVEL_TUNES` |
| 3 — Audio | `sfxAmbient.js`, `sfxWeapons.js`, `sfxEnemies.js` | `SfxAmbient`, `SfxWeapons`, `SfxEnemies` |
| 3 — Audio | `sfx.js` | `GameSFX` class, **`gameSFX`** singleton |
| 4 — Terrain | `terrainShaders.js` | `TERRAIN_CONFIG`, GLSL source strings |
| 4 — Terrain | `terrainMath.js` … `terrainBuildings.js`, `buildingGeometry.js` | `TerrainMath`, `TerrainGeometry`, `TerrainRender`, `TerrainShadows`, `TerrainTrees`, `TerrainBuildings` |
| 4 — Terrain | `terrain.js` | `Terrain` class, **`terrain`** singleton |
| 5 — Particles | `particles.js` | `ParticleSystem` class, **`particleSystem`** singleton |
| 5 — Particles | `projectiles.js` | `updateProjectilePhysics()`, `updateBarrierPhysics()` |
| 6 — Enemies | `enemyRenderer.js` | `EnemyRenderer` class |
| 6 — Enemies | `enemyAirBehaviors.js`, `enemyGroundBehaviors.js`, `enemyBossBehaviors.js` | `EnemyAirAI`, `EnemyGroundAI`, `EnemyBossAI` |
| 6 — Enemies | `enemies.js` | `EnemyManager` class, **`enemyManager`** singleton, `ENEMY_DRAW_SCALE` |
| 7 — Agents | `agentManager.js` | `AgentManager` base class, `ENEMY_CONFRONT_OFFSET` |
| 7 — Agents | `villagers.js` | `VillagerManager` class, **`villagerManager`** singleton |
| 7 — Agents | `wizards.js` | `WizardManager` class, **`wizardManager`** singleton |
| 8 — Player | `Vehicle.js` | `Vehicle` class |
| 8 — Player | `player.js` | `Player` class, `createPlayer`, `killPlayer`, `updateShipInput` |
| 9 — HUD | `hudCore.js` | `HUD_Manager`, `RADAR_SCALE`, `HUD_WEAPON_LABELS` |
| 9 — HUD | `hudComponents.js` | `drawHUD`, `_projectToRadar` |
| 9 — HUD | `hudScreens.js` | `drawMenu`, `drawGameOver`, `drawPauseScreen`, `HUD_Screens` |
| 10 — Input | `aimAssist.js` | **`aimAssist`** singleton |
| 10 — Input | `mobileControls.js` | `MobileController` class, **`mobileController`** singleton, `handleTouchStarted` |
| 10 — Input | `InputManager.js` | `InputManager` class, **`inputManager`** singleton |
| 10 — Input | `PhysicsEngine.js` | `PhysicsEngine` class, **`physicsEngine`** singleton |
| 11 — World | `worldGenerator.js` | `initWorld()`, `randomizeMountainPeaks()` |
| 11 — World | `gameState.js` | `GameState` class, **`gameState`** singleton |
| 11 — World | `gameRenderer.js` | `GameRenderer` class, **`gameRenderer`** singleton |
| 11 — World | `gameLoop.js` | **`GameLoop`** namespace (`checkCollisions`, `spreadInfection`, `updateLevelAndRespawn`, `updateAmbianceAudio`) |
| 12 — Entry | `sketch.js` | p5 hooks (`preload`, `setup`, `draw`), `startGame`, `startLevel` |

---

## 3. Singletons

These objects are created once at module scope and shared across all files.  
**Do not re-declare these names as local variables anywhere in the codebase.**

| Name | Owner file | Type |
|------|-----------|------|
| `infection` | `constants.js` | plain object |
| `gameSFX` | `sfx.js` | `GameSFX` instance |
| `terrain` | `terrain.js` | `Terrain` instance |
| `particleSystem` | `particles.js` | `ParticleSystem` instance |
| `enemyManager` | `enemies.js` | `EnemyManager` instance |
| `villagerManager` | `villagers.js` | `VillagerManager` instance |
| `wizardManager` | `wizards.js` | `WizardManager` instance |
| `aimAssist` | `aimAssist.js` | plain object |
| `mobileController` | `mobileControls.js` | `MobileController` instance |
| `inputManager` | `InputManager.js` | `InputManager` instance |
| `physicsEngine` | `PhysicsEngine.js` | `PhysicsEngine` instance |
| `gameState` | `gameState.js` | `GameState` instance |
| `gameRenderer` | `gameRenderer.js` | `GameRenderer` instance |
| `GameLoop` | `gameLoop.js` | `const` namespace object (not a class) |

---

## 4. Mutable Globals That Look Like Constants

`constants.js` has several `let` variables using UPPER_CASE naming that are  
**mutated at runtime**. Treat these as read-only from any file other than the  
noted writer.

| Variable(s) | Written by |
|-------------|-----------|
| `VIEW_NEAR`, `VIEW_FAR`, `CULL_DIST` | `sketch.js setup()`, `gameRenderer.js updatePerformanceScaling()` |
| `SKY_R/G/B`, `AMBIENT_R/G/B`, `SUN_KEY_R/G/B` | `updateTimeOfDay()` in `constants.js` |
| `SUN_DIR_X/Y/Z/LEN/NX/NY/NZ` | `updateTimeOfDay()` in `constants.js` |
| `SHADER_SUN_R/G/B`, `SHADER_AMB_L_R/G/B`, `SHADER_AMB_H_R/G/B` | `updateTimeOfDay()` in `constants.js` |
| `currentTimeStep` | `updateTimeOfDay()`, `sketch.js keyPressed()` |
| `MOUNTAIN_PEAKS` | `randomizeMountainPeaks()` in `worldGenerator.js` |

---

## 5. Key Cross-File Entanglements

| Coupling | Notes |
|---------|-------|
| `gameLoop.js` → `gameRenderer.setShake()` | Physics calls into renderer — the one intentional physics→renderer coupling. Marked `⚠️` in `gameLoop.js` header. |
| `gameLoop.js` `_ENEMY_HALF_SCALE_SQ` | Pre-computed at **parse time** using `ENEMY_DRAW_SCALE` from `enemies.js`. `enemies.js` **must** load before `gameLoop.js`. |
| `gameState.js` | Reads from nearly every other module. It is a hub, not an isolated model. |
| `sketch.js` → everything | `setup()` creates the canvas and initialises all singletons in dependency order. This is the only "constructor call site". |
| `player.js` dual pattern | Both `class Player` (instance methods) and standalone functions like `killPlayer(p)` that mutate player objects directly. Both patterns coexist. |

---

## 6. Safe Edit Checklist for LLM Editors

1. **Never import / require** — there are no modules; everything is global.
2. **Never re-declare a singleton name** as a `let` or `const` in any other file.
3. **Check `@requires`** in the file header before adding a dependency on another file.
4. **Check `@exports`** in the target file's header to confirm the symbol you want is actually exported.
5. **Do not add `class` static fields** to `GameLoop` — it is now a plain `const` object literal.
6. **Assume all `let UPPER_CASE` vars in `constants.js`** may change between frames.
7. **After any change to `gameLoop.js`**, run `node --check gameLoop.js` — object literal method commas are easy to break.
8. **Run `npm test`** (Puppeteer smoke test) after every change. It catches parse errors and WebGL panics but not logic bugs.
