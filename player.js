// =============================================================================
// player.js — Player / ship functions
//
// Covers the full lifecycle of a player-controlled ship:
//   • createPlayer / resetShip     — construction and respawn
//   • updateShipInput              — keyboard, mouse and mobile control integration
//   • updateProjectilePhysics      — bullet and homing-missile simulation
//   • shipDisplay / drawShipShadow — 3D rendering
//   • killPlayer                   — death handling (explosion, pulse, respawn timer)
//   • fireMissile                  — missile launch
//   • renderProjectiles            — draws bullets and missiles for one player
// =============================================================================

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

/**
 * Returns the world-space X spawn position for a given player.
 * In single-player mode both players share the centre (420); in two-player
 * mode they are offset to avoid spawning inside each other.
 * @param {object} p  Player object (uses p.id).
 * @returns {number}  World-space X offset for the launchpad position.
 */
function getSpawnX(p) {
  return numPlayers === 1 ? 420 : (p.id === 0 ? 320 : 520);
}

/**
 * Resets a player's ship state to the launchpad at the given X offset.
 * Called on game start and on respawn.
 * @param {object} p        Player object (ship state is written to p.ship).
 * @param {number} offsetX  World-space X of the spawn position.
 */
function resetShip(p, offsetX) {
  p.ship = { x: offsetX, y: LAUNCH_ALT, z: 420, vx: 0, vy: 0, vz: 0, pitch: 0, yaw: 0 };
}

/**
 * Constructs a new player object with default state and an initial ship.
 * @param {number}   id          Player index (0 or 1).
 * @param {object}   keys        Key-binding object from constants.js (P1_KEYS or P2_KEYS).
 * @param {number}   offsetX     World-space X spawn offset.
 * @param {number[]} labelColor  RGB colour used for HUD text and bullet colour.
 * @returns {object}  Fully initialised player state object.
 */
function createPlayer(id, keys, offsetX, labelColor) {
  let p = {
    id, keys, labelColor,
    score: 0,
    dead: false,
    respawnTimer: 0,
    bullets: [],
    homingMissiles: [],
    missilesRemaining: 1,
    weaponMode: 0,                // 0=NORMAL, 1=MISSILE, 2=BARRIER (index into WEAPON_MODES)
    shootHeld: false,             // Edge-detect for shoot key (prevents missile/barrier auto-repeat)
    aimTarget: null,              // Per-player locked ENEMY target for missile homing (never a virus tile)
    mobileMissilePressed: false,  // Tracks the mobile missile button edge so it fires once per tap
    lpDeaths: 0                   // Tracks consecutive deaths on an occupied launchpad
  };
  resetShip(p, offsetX);
  return p;
}

// ---------------------------------------------------------------------------
// Projectile factory
// ---------------------------------------------------------------------------

/**
 * Calculates the initial position and velocity for a projectile fired from
 * the given ship state.  The spawn point is offset 30 units in front of and
 * 10 units below the ship nose so the projectile starts at the gun barrel.
 *
 * @param {{x,y,z,vx,vy,vz,pitch,yaw}} s  Ship state.
 * @param {number} power  Initial forward speed added to the ship's velocity.
 * @param {number} life   Lifetime counter (decremented each frame).
 * @returns {{x,y,z,vx,vy,vz,life}}  Projectile state object.
 */
function spawnProjectile(s, power, life) {
  let cp = cos(s.pitch), sp = sin(s.pitch);
  let cy = cos(s.yaw), sy = sin(s.yaw);

  // Forward unit vector in world space
  let fx = -cp * sy;
  let fy = sp;
  let fz = -cp * cy;

  // Barrel offset: 30 units forward, 10 units below the ship centre
  let lz = -30, ly = 10;
  let y1 = ly * cp - lz * sp;
  let z1 = ly * sp + lz * cp;

  return {
    x: s.x + z1 * sy,
    y: s.y + y1,
    z: s.z + z1 * cy,
    vx: fx * power + s.vx,
    vy: fy * power + s.vy,
    vz: fz * power + s.vz,
    life
  };
}

/**
 * Fires a homing missile from the player's ship if missiles are available.
 * Decrements missilesRemaining, pushes the missile into homingMissiles[], and
 * plays a launch sound effect.
 * @param {object} p  Player state object.
 */
function fireMissile(p) {
  if (p.missilesRemaining > 0 && !p.dead) {
    p.missilesRemaining--;
    p.homingMissiles.push(spawnProjectile(p.ship, 8, 300));
    if (typeof gameSFX !== 'undefined') gameSFX.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
  }
}

/**
 * Fires a barrier projectile from the player's ship.  The barrier travels
 * forward, is affected by gravity, and embeds itself in the ground on landing.
 * Once landed it acts as a permanent wall segment for this level.
 * @param {object} p  Player state object.
 */
function fireBarrier(p) {
  if (p.dead) return;
  inFlightBarriers.push(spawnProjectile(p.ship, 14, 300));
  if (typeof gameSFX !== 'undefined') gameSFX.playMissileFire(p.ship.x, p.ship.y, p.ship.z);
}

/**
 * Fires the player's currently selected weapon:
 *   NORMAL (0) — fires a single bullet burst
 *   MISSILE (1) — launches a homing missile
 *   BARRIER (2) — places a barrier projectile
 * @param {object} p  Player state object.
 */
function fireActiveWeapon(p) {
  if (p.dead) return;
  let mode = p.weaponMode;
  if (mode === 1) fireMissile(p);
  else if (mode === 2) fireBarrier(p);
  else {
    // NORMAL: fire one bullet immediately (used for middle-click single shot)
    p.bullets.push(spawnProjectile(p.ship, 25, 300));
    if (typeof gameSFX !== 'undefined') gameSFX.playShot(p.ship.x, p.ship.y, p.ship.z);
  }
}

// ---------------------------------------------------------------------------
// Ship geometry helpers
// ---------------------------------------------------------------------------

/**
 * Returns the world-space up vector of the ship (pointing away from the thrust
 * nozzle).  Used to apply thrust force in the correct direction regardless of
 * the ship's orientation.
 * @param {{pitch,yaw}} s  Ship state.
 * @returns {{x,y,z}}  Unit up vector in world space.
 */
function shipUpDir(s) {
  let sp = sin(s.pitch), cp = cos(s.pitch);
  let sy = sin(s.yaw), cy = cos(s.yaw);
  return { x: sp * -sy, y: -cp, z: sp * -cy };
}

/**
 * Draws a soft semi-transparent ellipse shadow directly on the ground below
 * any object.  Skipped when the ground is below sea level (shadow would be
 * invisible under water).
 * @param {number} x       World X of the object.
 * @param {number} groundY World Y of the ground directly below the object.
 * @param {number} z       World Z of the object.
 * @param {number} w       Shadow ellipse width.
 * @param {number} h       Shadow ellipse height.
 */
function drawShadow(x, groundY, z, w, h) {
  if (aboveSea(groundY)) return;
  push();
  translate(x, groundY - 0.5, z);
  rotateX(PI / 2);
  fill(0, 0, 0, 50);
  ellipse(0, 0, w, h);
  pop();
}

/**
 * Draws the perspective-correct triangular ground shadow for the player's ship.
 * The shadow spreads outward and fades as altitude increases.
 * @param {number} x       Ship world X.
 * @param {number} groundY Ground altitude below the ship.
 * @param {number} z       Ship world Z.
 * @param {number} yaw     Ship yaw (used to orient the shadow).
 * @param {number} alt     Ship current altitude Y.
 */
function drawShipShadow(x, groundY, z, yaw, alt) {
  if (aboveSea(groundY)) return;
  let spread = max(1, (groundY - alt) * 0.012);
  let alpha = map(groundY - alt, 0, 600, 60, 15, true);
  push();
  translate(x, groundY - 0.3, z);
  rotateY(yaw);
  noStroke();
  fill(0, 0, 0, alpha);
  // Triangular shadow pointing forward
  beginShape();
  vertex(-15 * spread, 0, 15 * spread);
  vertex(15 * spread, 0, 15 * spread);
  vertex(0, 0, -25 * spread);
  endShape(CLOSE);
  pop();
}

// ---------------------------------------------------------------------------
// Ship rendering
// ---------------------------------------------------------------------------

/**
 * Renders the player's ship as four coloured triangular faces forming a low-poly
 * tetrahedron.  The tintColor parameter blends each face toward the player's
 * label colour so P1 (blue) and P2 (orange) are visually distinct.
 *
 * The terrain shader is applied before rendering the faces (so the ship picks up
 * pulse ring effects) and then reset afterward so subsequent objects use normal
 * lighting.
 *
 * @param {{x,y,z,pitch,yaw}} s    Ship state.
 * @param {number[]}          tintColor  RGB player colour [r, g, b].
 */
function shipDisplay(s, tintColor) {
  terrain.applyShader();
  noStroke();

  let cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
  let cx = Math.cos(s.pitch), sx = Math.sin(s.pitch);

  // Transform a local-space point through pitch then yaw and offset to world space
  let transform = (pt) => {
    let x = pt[0], y = pt[1], z = pt[2];
    let y1 = y * cx - z * sx;
    let z1 = y * sx + z * cx;
    let x2 = x * cy + z1 * sy;
    let z2 = -x * sy + z1 * cy;
    return [x2 + s.x, y1 + s.y, z2 + s.z];
  };

  let r = tintColor[0], g = tintColor[1], b = tintColor[2];

  // Four faces with slightly different tint strengths for a faceted look
  let faces = [
    // Bottom face (brightest)
    [lerp(200, r, 0.3), lerp(200, g, 0.3), lerp(200, b, 0.3), [-15, 10, 15], [15, 10, 15], [0, 10, -25]],
    // Left face
    [lerp(170, r, 0.2), lerp(170, g, 0.2), lerp(170, b, 0.2), [0, -10, 5], [-15, 10, 15], [0, 10, -25]],
    // Right face
    [lerp(150, r, 0.2), lerp(150, g, 0.2), lerp(150, b, 0.2), [0, -10, 5], [15, 10, 15], [0, 10, -25]],
    // Rear/belly face (darkest)
    [lerp(130, r, 0.15), lerp(130, g, 0.15), lerp(130, b, 0.15), [0, -10, 5], [-15, 10, 15], [15, 10, 15]]
  ];

  for (let [cr, cg, cb, a, bf, d] of faces) {
    fill(cr, cg, cb);
    beginShape();
    vertex(...transform(a)); vertex(...transform(bf)); vertex(...transform(d));
    endShape(CLOSE);
  }

  resetShader();
  setSceneLighting();

  let gy = terrain.getAltitude(s.x, s.z);
  drawShipShadow(s.x, gy, s.z, s.yaw, s.y);
}

// ---------------------------------------------------------------------------
// Input and physics update
// ---------------------------------------------------------------------------

/**
 * Processes all input sources (keyboard, mouse, mobile joystick) and integrates
 * the ship's physics for one frame.
 *
 * Physics model:
 *   1. Gravity applied to vy each frame (GRAV = 0.09).
 *   2. Thrust adds force along the ship's up vector when W/RMB is held.
 *   3. Braking multiplies all velocity components by 0.96.
 *   4. Global drag: velocity × 0.985 every frame.
 *   5. Collision with the ground: land softly if approach speed < 2.8 m/f,
 *      kill the player on hard impact.
 *   6. Collision with the sea: instant kill.
 *
 * Thrust particles (orange exhaust) are emitted every other frame when thrusting.
 *
 * @param {object} p  Player state object (mutated in place).
 */
function updateShipInput(p) {
  if (p.dead) return;

  // Reset each frame so stale enemy references never persist across frames.
  p.aimTarget = null;

  // --- Mouse steering (pointer-lock, desktop P1 only) ---
  if (p.id === 0 && !isMobile && document.pointerLockElement) {
    smoothedMX = lerp(smoothedMX, movedX, MOUSE_SMOOTHING);
    smoothedMY = lerp(smoothedMY, movedY, MOUSE_SMOOTHING);

    let newYaw = p.ship.yaw - smoothedMX * MOUSE_SENSITIVITY;
    // Pitch polarity depends on camera mode:
    //   behind-ship (default): mouse-down = nose up (original behaviour) → subtract
    //   first-person:          mouse-down = nose down                     → add
    let pitchSign = (typeof firstPersonView !== 'undefined' && firstPersonView) ? 1 : -1;
    let newPitch = p.ship.pitch + pitchSign * smoothedMY * MOUSE_SENSITIVITY;

    // Apply aim assist if enabled
    if (aimAssist.enabled) {
      let assist = aimAssist.getAssistDeltas(p.ship, enemyManager.enemies, false);
      newYaw += assist.yawDelta;
      newPitch += assist.pitchDelta;
      // Only an enemy lock sets aimTarget — virus-tile assist steers the nose only
      p.aimTarget = aimAssist.lastTracking.target;
    }
    p.ship.yaw = newYaw;
    p.ship.pitch = constrain(newPitch, -PI / 2.2, PI / 2.2);
  }

  let k = p.keys;

  // Track mouse release so clicking to enter fullscreen / pointer-lock doesn't
  // accidentally fire the gun on the first frame of gameplay.
  if (!leftMouseDown) mouseReleasedSinceStart = true;

  let isThrusting = keyIsDown(k.thrust) || (p.id === 0 && !isMobile && rightMouseDown);
  let isBraking = keyIsDown(k.brake);
  let isShooting = keyIsDown(k.shoot) || (p.id === 0 && !isMobile && leftMouseDown && mouseReleasedSinceStart);

  // --- Mobile joystick / button input ---
  if (isMobile && p.id === 0 && typeof mobileController !== 'undefined') {
    let inputs = mobileController.getInputs(p.ship, enemyManager.enemies, YAW_RATE, PITCH_RATE);

    isThrusting = isThrusting || inputs.thrust;
    isShooting = isShooting || inputs.shoot;

    // Edge-detect the missile button so a single tap fires one missile
    if (inputs.missile && !p.mobileMissilePressed) {
      fireMissile(p);
      p.mobileMissilePressed = true;
    } else if (!inputs.missile) {
      p.mobileMissilePressed = false;
    }

    p.ship.yaw += inputs.yawDelta + inputs.assistYaw;
    p.ship.pitch = constrain(p.ship.pitch + inputs.pitchDelta + inputs.assistPitch, -PI / 2.2, PI / 2.2);
    // Only an enemy lock sets aimTarget — virus-tile assist steers the nose only
    p.aimTarget = aimAssist.lastTracking.target;
  }

  // --- Keyboard steering ---
  if (keyIsDown(k.left)) p.ship.yaw += YAW_RATE;
  if (keyIsDown(k.right)) p.ship.yaw -= YAW_RATE;
  // Keyboard pitch: original behaviour — pitchUp adds, pitchDown subtracts, regardless of camera mode.
  if (keyIsDown(k.pitchUp)) p.ship.pitch = constrain(p.ship.pitch + PITCH_RATE, -PI / 2.2, PI / 2.2);
  if (keyIsDown(k.pitchDown)) p.ship.pitch = constrain(p.ship.pitch - PITCH_RATE, -PI / 2.2, PI / 2.2);

  // Aim assist for keyboard players (P2 always; P1 when not using mouse pointer-lock).
  // Skipped for the mouse-look path (already handled above).
  const isKeyboardPlayer = !(p.id === 0 && document.pointerLockElement);
  if (!isMobile && aimAssist.enabled && isKeyboardPlayer) {
    let kAssist = aimAssist.getAssistDeltas(p.ship, enemyManager.enemies, false);
    p.ship.yaw += kAssist.yawDelta;
    p.ship.pitch = constrain(p.ship.pitch + kAssist.pitchDelta, -PI / 2.2, PI / 2.2);
    // Only an enemy lock sets aimTarget — virus-tile assist steers the nose only
    p.aimTarget = aimAssist.lastTracking.target;
  }

  let s = p.ship;

  // --- Physics integration ---
  s.vy += GRAV;  // Gravity

  if (isThrusting) {
    let pw = 0.45;
    let dVec = shipUpDir(s);
    s.vx += dVec.x * pw; s.vy += dVec.y * pw; s.vz += dVec.z * pw;
    // Emit orange exhaust particles every other frame
    if (frameCount % 2 === 0) {
      particleSystem.particles.push({
        x: s.x, y: s.y, z: s.z,
        vx: -dVec.x * 8 + random(-1, 1),
        vy: -dVec.y * 8 + random(-1, 1),
        vz: -dVec.z * 8 + random(-1, 1),
        life: 255, decay: 10, seed: random(1.0), size: random(2, 6),
        color: [180, 140, 100]
      });
    }
  }

  if (isBraking) {
    s.vx *= 0.96; s.vy *= 0.96; s.vz *= 0.96;
  }

  // Fire based on selected weapon mode
  if (p.weaponMode === 0) {
    // NORMAL: rapid-fire bullets every 6 frames while shoot is held
    if (isShooting && frameCount % 6 === 0) {
      p.bullets.push(spawnProjectile(s, 25, 300));
      if (typeof gameSFX !== 'undefined') gameSFX.playShot(s.x, s.y, s.z);
    }
    p.shootHeld = isShooting;
  } else {
    // MISSILE / BARRIER: fire once per press (edge-detect on shoot button)
    if (isShooting && !p.shootHeld) {
      if (p.weaponMode === 1) fireMissile(p);
      else if (p.weaponMode === 2) fireBarrier(p);
    }
    p.shootHeld = isShooting;
  }

  // Global air drag
  s.vx *= 0.985; s.vy *= 0.985; s.vz *= 0.985;
  s.x += s.vx; s.y += s.vy; s.z += s.vz;

  let g = terrain.getAltitude(s.x, s.z);

  // Sea collision — instant death
  if (s.y > SEA - 12) {
    killPlayer(p);
    return;
  }

  // Terrain collision — bounce softly or kill on hard impact
  if (s.y > g - 12) {
    if (s.vy > 2.8) killPlayer(p);
    else { s.y = g - 12; s.vy = 0; s.vx *= 0.8; s.vz *= 0.8; }
  }
}

/**
 * Kills the player: spawns a ship-type explosion, triggers a shockwave pulse on
 * the terrain, marks the player dead and starts the 120-frame (~2 s) respawn timer.
 * All in-flight bullets are discarded.
 * @param {object} p  Player state object.
 */
function killPlayer(p) {
  particleSystem.addExplosion(p.ship.x, p.ship.y, p.ship.z);
  terrain.addPulse(p.ship.x, p.ship.z, 2.0);  // Yellow ship-explosion ring (type 2)
  p.dead = true;
  p.respawnTimer = 120;  // ~2 seconds at 60 fps
  p.bullets = [];

  // --- "Launch Pad Taken Over" detection ---
  // If the player dies on the launch pad while an enemy is also on the pad,
  // we increment a special counter.  Two such deaths end the game.
  if (isLaunchpad(p.ship.x, p.ship.z)) {
    let enemyOnPad = enemyManager.enemies.some(e => isLaunchpad(e.x, e.z));
    if (enemyOnPad) {
      p.lpDeaths = (p.lpDeaths || 0) + 1;
      if (p.lpDeaths >= 3) {
        if (typeof gameState !== 'undefined') {
          gameState = 'gameover';
          gameOverReason = 'LAUNCH PAD TAKEN OVER';
          levelEndTime = millis();
          if (typeof gameSFX !== 'undefined') gameSFX.playGameOver();
        }
      }
    } else {
      p.lpDeaths = 0; // Enemy cleared the pad, reset counter
    }
  } else {
    p.lpDeaths = 0; // Died elsewhere, reset counter
  }
}

/**
 * Advances bullet and homing-missile physics for one frame.
 *
 * Bullets: linear motion, 2-life-per-frame decay.  Removed when they hit terrain
 * or expire; terrain hit attempts to clear infected tiles.
 *
 * Homing missiles: use a lerped velocity toward the nearest enemy (blend factor
 * 0.12) capped at maxSpd = 10.  Emit a smoke trail every other frame.  On terrain
 * impact they trigger an explosion and attempt to clear infection.
 *
 * @param {object} p  Player state object containing bullets[] and homingMissiles[].
 */
function updateProjectilePhysics(p) {
  // --- Bullets ---
  // Aim assist flag is constant for the duration of this frame's bullet updates
  let assistEnabled = aimAssist.enabled;
  for (let i = p.bullets.length - 1; i >= 0; i--) {
    let b = p.bullets[i];

    // PERFORMANCE: Only seeking for "fresh" bullets (first 30 frames)
    // and only if Aim Assist is enabled (for P1 or via 'P' toggle)
    if (assistEnabled && b.life > 240) { // Bullets start at 300 life
      let bestTarget = null;
      let bestDot = 0.985;
      let speed = Math.hypot(b.vx, b.vy, b.vz);

      if (speed > 0) {
        let bDirX = b.vx / speed, bDirY = b.vy / speed, bDirZ = b.vz / speed;

        // 1. Enemies (Highest priority)
        for (let e of enemyManager.enemies) {
          let dx = e.x - b.x, dy = e.y - b.y, dz = e.z - b.z;
          let dSq = dx * dx + dy * dy + dz * dz;

          if (dSq < 1440000 && dSq > 400) { // 1200^2 and 20^2
            let d = Math.sqrt(dSq);
            let dot = (dx / d) * bDirX + (dy / d) * bDirY + (dz / d) * bDirZ;
            if (dot > bestDot) {
              bestDot = dot;
              // PREDICTIVE: Seek lead position (pass pre-calculated d)
              bestTarget = aimAssist._getPredictedPos(b, e, speed, d);
            }
          }
        }

        // 2. Virus (Halved frequency: check only on even frames to save CPU)
        if (!bestTarget && frameCount % 2 === 0) {
          let bTx = Math.floor(b.x / 120), bTz = Math.floor(b.z / 120);
          for (let tz = bTz - 2; tz <= bTz + 2; tz++) {
            for (let tx = bTx - 2; tx <= bTx + 2; tx++) {
              let k = tx + ',' + tz;
              if (infection.tiles[k]) {
                let txPos = tx * 120 + 60, tzPos = tz * 120 + 60;
                let tyPos = terrain.getAltitude(txPos, tzPos);
                let dx = txPos - b.x, dy = tyPos - b.y, dz = tzPos - b.z;
                let dSq = dx * dx + dy * dy + dz * dz;
                if (dSq < 360000) { // 600^2
                  let d = Math.sqrt(dSq);
                  let dot = (dx / d) * bDirX + (dy / d) * bDirY + (dz / d) * bDirZ;
                  if (dot > bestDot) {
                    bestDot = dot;
                    bestTarget = { x: txPos, y: tyPos, z: tzPos };
                  }
                }
              }
            }
          }
        }
      }

      if (bestTarget) {
        let dx = bestTarget.x - b.x, dy = bestTarget.y - b.y, dz = bestTarget.z - b.z;
        let d = Math.hypot(dx, dy, dz);
        let steer = 0.04;
        b.vx = lerp(b.vx, (dx / d) * speed, steer);
        b.vy = lerp(b.vy, (dy / d) * speed, steer);
        b.vz = lerp(b.vz, (dz / d) * speed, steer);
      }
    }

    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.life -= 2;
    if (b.life <= 0) {
      p.bullets.splice(i, 1);
    } else if (b.y > terrain.getAltitude(b.x, b.z)) {
      // Bullet hit terrain — attempt to clear infection
      clearInfectionAt(b.x, b.z, p);
      p.bullets.splice(i, 1);

    }
  }

  // --- Homing missiles ---
  for (let i = p.homingMissiles.length - 1; i >= 0; i--) {
    let m = p.homingMissiles[i];
    const maxSpd = 10;

    // Use this player's locked aim target; fall back to nearest enemy
    let target = p.aimTarget || findNearest(enemyManager.enemies, m.x, m.y, m.z);

    if (target) {
      // Predictive lead when aim assist is on; direct homing otherwise (no aimAssist overhead)
      let dest = aimAssist.enabled ? aimAssist._getPredictedPos(m, target, maxSpd) : target;
      let dx = dest.x - m.x, dy = dest.y - m.y, dz = dest.z - m.z;
      let dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > 0) {
        let mg = Math.sqrt(dSq);
        let bl = 0.12;  // Blend factor — higher = more responsive homing
        m.vx = lerp(m.vx, (dx / mg) * maxSpd, bl);
        m.vy = lerp(m.vy, (dy / mg) * maxSpd, bl);
        m.vz = lerp(m.vz, (dz / mg) * maxSpd, bl);
      }
    }

    // Clamp speed to maxSpd so homing can't accelerate without limit
    let spSq = m.vx * m.vx + m.vy * m.vy + m.vz * m.vz;
    if (spSq > maxSpd * maxSpd) {
      let sp = Math.sqrt(spSq);
      m.vx = (m.vx / sp) * maxSpd;
      m.vy = (m.vy / sp) * maxSpd;
      m.vz = (m.vz / sp) * maxSpd;
    }

    m.x += m.vx; m.y += m.vy; m.z += m.vz;
    m.life--;

    // Smoke trail — one particle every other frame
    if (frameCount % 2 === 0) {
      particleSystem.particles.push({
        x: m.x, y: m.y, z: m.z,
        vx: random(-.5, .5), vy: random(-.5, .5), vz: random(-.5, .5),
        life: 120, decay: 5, seed: random(1.0), size: random(2, 5)
      });
    }

    let gnd = terrain.getAltitude(m.x, m.z);
    if (m.life <= 0 || m.y > gnd) {
      if (m.y > gnd) {
        // Hit terrain — explode and attempt infection clear
        particleSystem.addExplosion(m.x, m.y, m.z);
        clearInfectionAt(m.x, m.z, p);
      }
      p.homingMissiles.splice(i, 1);
    }
  }

}

/**
 * Advances all in-flight barrier projectiles one frame.
 * On landing, snaps to tile grid and adds key to barrierTiles (dedup is automatic).
 */
function updateBarrierPhysics() {
  for (let i = inFlightBarriers.length - 1; i >= 0; i--) {
    let b = inFlightBarriers[i];
    b.vy += 0.15;  // Gravity
    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.life--;
    if (b.y >= terrain.getAltitude(b.x, b.z) || b.life <= 0) {
      if (b.life > 0) { // Landed (not expired)
        let tx = Math.floor(b.x / TILE), tz = Math.floor(b.z / TILE);
        let k = tileKey(tx, tz);
        if (!barrierTiles.has(k)) barrierTiles.set(k, { k, tx, tz, verts: null });
      }
      inFlightBarriers.splice(i, 1);
    }
  }
}

/**
 * Renders all in-flight barrier projectiles as small white cubes.
 * Called once per viewport from the main render loop.
 * @param {number} camX  Camera world X.
 * @param {number} camZ  Camera world Z.
 */
function renderInFlightBarriers(camX, camZ) {
  if (!inFlightBarriers.length) return;
  const cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);
  noStroke(); fill(255, 255, 255, 220);
  for (let b of inFlightBarriers) {
    if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 > cullSq) continue;
    push(); translate(b.x, b.y, b.z); box(8); pop();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Renders the player's bullets (small coloured cubes) and homing missiles
 * (cyan cubes) from the perspective of the given viewport camera.
 * Objects beyond 80% of CULL_DIST are skipped.
 * @param {object} p     Player state containing bullets[] and homingMissiles[].
 * @param {number} camX  Camera world X (viewport camera, not ship).
 * @param {number} camZ  Camera world Z.
 */
function renderProjectiles(p, camX, camZ) {
  let cullSq = (CULL_DIST * 0.8) * (CULL_DIST * 0.8);

  for (let b of p.bullets) {
    if ((b.x - camX) ** 2 + (b.z - camZ) ** 2 > cullSq) continue;
    push(); translate(b.x, b.y, b.z); noStroke();
    fill(p.labelColor[0], p.labelColor[1], p.labelColor[2]);
    box(6);
    pop();
  }

  for (let m of p.homingMissiles) {
    if ((m.x - camX) ** 2 + (m.z - camZ) ** 2 > cullSq) continue;

    push();
    translate(m.x, m.y, m.z);

    // Direct orientation toward velocity vector
    let h = Math.sqrt(m.vx * m.vx + m.vz * m.vz);
    rotateY(Math.atan2(m.vx, m.vz));
    rotateX(Math.atan2(-m.vy, h));

    noStroke();

    // Body (Main Fuselage)
    fill(0, 180, 255);
    box(3, 3, 14);

    // Nose Cone (Pointed Tip)
    push();
    translate(0, 0, 10);
    rotateX(PI / 2);
    fill(255);
    cone(2, 6, 4); // Low-poly pyramid-like nose
    pop();

    // Faint Glow / Core
    fill(255, 255, 255, 100);
    box(1, 1, 16);

    // Fins (Tail stabilizers)
    fill(0, 100, 255);
    translate(0, 0, -6);
    box(10, 1, 4); // Horizontal fins
    box(1, 10, 4); // Vertical fins

    pop();
  }
}
