# Viron

An action-packed 3D space shooter PWA. Fight the viral outbreak across an infinite alien landscape.

## Playing

Open `index.html` in a modern browser, or visit the live hosted version.  
The game works best in Chrome / Edge. A **keyboard + mouse** or **touch screen** are both supported.

### Controls (Desktop)

| Action | Key / Mouse |
|---|---|
| Thrust | `W` / `↑` |
| Brake | `S` / `↓` |
| Roll left / right | `A` / `D` |
| Pitch up / down | `↑` / `↓` |
| Fire | `Space` / Left click |
| Cycle weapon | `Tab` |
| First-person view | `V` |

### Controls (Mobile / Touch)

On-screen virtual joystick and fire buttons are displayed automatically on touch devices.

---

## Project Structure

```
viron/
├── index.html            # Game entry point
├── style.css             # Global styles
├── sketch.js             # p5.js setup / draw loop
├── constants.js          # Shared game constants
├── gameLoop.js           # Main update loop (physics, AI, collisions)
├── gameRenderer.js       # WebGL post-processing and render pipeline
├── gameState.js          # Global game state
├── terrain.js            # Terrain generation, shaders, rendering
├── terrainShaders.js     # GLSL shader sources
├── enemies.js            # Enemy types, AI, spawning
├── player.js             # Player ship state and input
├── particles.js          # Particle system
├── hudCore.js            # HUD core drawing helpers
├── hudComponents.js      # HUD component widgets
├── hudScreens.js         # Menu / splash screens
├── mobileControls.js     # Touch / virtual joystick
├── aimAssist.js          # Auto-aim and missile homing
├── buildingGeometry.js   # Procedural building geometry
├── shipDesigns.js        # Ship geometry and designs
├── sfx.js                # Sound effects (Web Audio)
├── sw.js                 # Service worker (offline PWA)
├── manifest.json         # PWA manifest
├── p5.js                 # p5.js library (v1.11.3)
├── p5.sound.min.js       # p5.sound library
├── icons/                # PWA icons (SVG source + generated PNGs)
├── scripts/              # Developer utility scripts
│   └── generate-icons.js #   Regenerate PNG icons from SVG sources
├── tests/                # Test suite
│   └── test.js           #   Smoke test (puppeteer)
├── benchmarks/           # Performance benchmarks
│   ├── benchmark-terrain.js
│   ├── benchmark-throttling.js
│   ├── benchmark-particles.js
│   ├── benchmark-enemies.js
│   ├── benchmark-enemy-math.js
│   ├── benchmark-runtime-breakdown.js
│   └── benchmark-viron.js
└── docs/
    ├── TODO.md           # Development backlog
    └── PWA-STORE-GUIDE.md  # App store submission guide (see below)
```

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- Chrome or Chromium (for headless tests / benchmarks)

### Install dependencies

```bash
npm install
```

### Run the smoke test

Launches a headless Chrome session, loads the game, and checks for WebGL or JS errors:

```bash
npm test
```

### Benchmarks

```bash
npm run benchmark              # Terrain rendering microbenchmarks
npm run benchmark-throttle     # Dynamic quality scaling simulation
npm run benchmark-particles    # Particle system CPU benchmarks
npm run benchmark-enemies      # Enemy geometry benchmarks
CHROME_PATH=/usr/bin/google-chrome npm run benchmark-enemy-math
CHROME_PATH=/usr/bin/google-chrome npm run benchmark-runtime
CHROME_PATH=/usr/bin/google-chrome npm run benchmark-viron
```

### Regenerate PWA icons

```bash
npm run generate-icons
```

---

## Store Submission

See [`docs/PWA-STORE-GUIDE.md`](docs/PWA-STORE-GUIDE.md) for step-by-step instructions to publish Viron to the **Google Play Store** (via Trusted Web Activity) and the **Apple App Store** (via Capacitor or PWABuilder).

---

## License

ISC
