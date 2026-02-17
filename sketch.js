// Game Constants
const TILE_SIZE = 120;
const SEA_LEVEL = 200;
const LAUNCHPAD_ALTITUDE = 100;
const GRAVITY = 0.06;
const VIEW_RANGE = 60; 

let ship;
let trees = [];
let particles = [];
let bullets = [];
let enemies = [];
let score = 0;

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  ship = {
    x: 400, y: LAUNCHPAD_ALTITUDE - 20, z: 400,
    vx: 0, vy: 0, vz: 0,
    pitch: 0, yaw: 0    
  };
  
  randomSeed(42);
  for(let i=0; i<150; i++) {
    trees.push({x: random(-5000, 5000), z: random(-5000, 5000), type: random()>0.5});
  }
  for(let i=0; i<15; i++) spawnEnemy();
}

function spawnEnemy() {
  enemies.push({
    x: random(-4000, 4000), y: random(-300, -800), z: random(-4000, 4000),
    vx: random(-2, 2), vz: random(-2, 2), id: random()
  });
}

function draw() {
  background(5, 10, 20); 
  
  // Handle Controls & Physics
  updateShip();
  updateEnemies();
  checkCollisions();
  
  // --- 3D WORLD RENDERING ---
  push();
  // Camera Setup
  let camDist = 550;
  let camX = ship.x + sin(ship.yaw) * camDist;
  let camZ = ship.z + cos(ship.yaw) * camDist;
  let camY = ship.y - 120;
  if (camY > SEA_LEVEL - 60) camY = SEA_LEVEL - 60;
  camera(camX, camY, camZ, ship.x, ship.y, ship.z, 0, 1, 0);

  // Scene Elements
  directionalLight(255, 255, 255, 0.5, 1, -0.5);
  ambientLight(70);
  drawLandscape();
  drawTrees();
  drawEnemies();
  shipDisplay();
  updateParticles(); // Now handles movement for all particles
  pop();

  // --- HUD LAYER ---
  drawRadar();
}

function updateShip() {
  if (document.pointerLockElement) {
    ship.yaw -= movedX * 0.003;
    ship.pitch = constrain(ship.pitch + movedY * 0.003, -PI/2.2, PI/2.2);
  }

  ship.vy += GRAVITY; 

  if (mouseIsPressed && document.pointerLockElement) {
    let power = 0.45;
    // Directional vectors
    let dirX = sin(ship.pitch) * -sin(ship.yaw);
    let dirY = -cos(ship.pitch);
    let dirZ = sin(ship.pitch) * -cos(ship.yaw);

    ship.vx += dirX * power;
    ship.vy += dirY * power;
    ship.vz += dirZ * power;

    // Spawn exhaust particles
    if (frameCount % 2 == 0) {
      particles.push({
        x: ship.x, y: ship.y, z: ship.z, 
        vx: -dirX * 8 + random(-1,1), 
        vy: -dirY * 8 + random(-1,1), 
        vz: -dirZ * 8 + random(-1,1), 
        life: 255
      });
    }
  }

  if (keyIsDown(SHIFT) && frameCount % 6 === 0) {
    let bPower = 25;
    bullets.push({
      x: ship.x, y: ship.y, z: ship.z,
      vx: cos(ship.pitch) * -sin(ship.yaw) * bPower + ship.vx,
      vy: sin(ship.pitch) * bPower + ship.vy,
      vz: cos(ship.pitch) * -cos(ship.yaw) * bPower + ship.vz,
      life: 100
    });
  }

  ship.vx *= 0.985; ship.vy *= 0.985; ship.vz *= 0.985;
  ship.x += ship.vx; ship.y += ship.vy; ship.z += ship.vz;

  let ground = getAltitude(ship.x, ship.z);
  if (ship.y > ground - 12) {
    if (ship.vy > 2.8) resetGame();
    else { ship.y = ground - 12; ship.vy = 0; ship.vx *= 0.8; ship.vz *= 0.8; }
  }
}

function drawRadar() {
  push();
  // Set to 2D Overlay mode
  ortho(-width/2, width/2, -height/2, height/2, 0, 1000);
  resetMatrix();
  
  // Position in Top Right
  translate(width/2 - 100, -height/2 + 100, 0); 
  
  // Background
  fill(0, 150); stroke(0, 255, 0); strokeWeight(2);
  rectMode(CENTER);
  rect(0, 0, 160, 160);
  
  // ROTATION: Rotate the radar map relative to ship's yaw
  rotateZ(-ship.yaw); 
  
  // Enemy dots
  fill(255, 0, 0); noStroke();
  enemies.forEach(e => {
    let rx = (e.x - ship.x) * 0.015;
    let rz = (e.z - ship.z) * 0.015;
    if (abs(rx) < 75 && abs(rz) < 75) {
      rect(rx, rz, 4, 4);
    }
  });

  // Player dot (counter-rotate so the icon stays square)
  rotateZ(ship.yaw);
  fill(255, 255, 0);
  rect(0, 0, 6, 6);
  
  pop();
}

function updateParticles() {
  // Exhaust/Explosion Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    let p = particles[i]; 
    p.x += p.vx; p.y += p.vy; p.z += p.vz;
    p.life -= 10;
    
    push(); 
    translate(p.x, p.y, p.z); 
    noStroke(); 
    fill(255, 150, 0, p.life); 
    sphere(2); 
    pop();
    
    if (p.life <= 0) particles.splice(i, 1);
  }
  
  // Bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    let b = bullets[i]; b.x += b.vx; b.y += b.vy; b.z += b.vz; b.life -= 2;
    push(); translate(b.x, b.y, b.z); noStroke(); fill(255, 255, 0); sphere(3); pop();
    if (b.life <= 0 || b.y > getAltitude(b.x, b.z)) bullets.splice(i, 1);
  }
}

// --- WORLD LOGIC (Unchanged but included for completeness) ---

function checkCollisions() {
  for (let j = enemies.length - 1; j >= 0; j--) {
    bullets.forEach((b, i) => {
      if (dist(b.x, b.y, b.z, enemies[j].x, enemies[j].y, enemies[j].z) < 50) {
        explosion(enemies[j].x, enemies[j].y, enemies[j].z);
        enemies.splice(j, 1);
        bullets.splice(i, 1);
        spawnEnemy();
      }
    });
    if (enemies[j] && dist(ship.x, ship.y, ship.z, enemies[j].x, enemies[j].y, enemies[j].z) < 40) {
      resetGame();
    }
  }
}

function getAltitude(x, z) {
  if (x > 0 && x < 800 && z > 0 && z < 800) return LAUNCHPAD_ALTITUDE;
  let xS = x * 0.001, zS = z * 0.001;
  let y = (2*sin(xS - 2*zS) + 2*sin(4*xS + 3*zS) + 2*sin(3*zS - 5*xS)) * 60;
  return 250 - y;
}

function drawLandscape() {
  let gx = Math.floor(ship.x / TILE_SIZE);
  let gz = Math.floor(ship.z / TILE_SIZE);
  for (let z = gz - VIEW_RANGE; z < gz + VIEW_RANGE; z++) {
    beginShape(TRIANGLE_STRIP);
    for (let x = gx - VIEW_RANGE; x <= gx + VIEW_RANGE; x++) {
      let xP = x * TILE_SIZE, zP = z * TILE_SIZE;
      let yP = getAltitude(xP, zP);
      if (yP >= SEA_LEVEL - 1) fill(20, 50, 180); 
      else if (xP >= 0 && xP < 800 && zP >= 0 && zP < 800) fill(110); 
      else fill(45, 130 - (yP/3), 45);
      vertex(xP, yP, zP);
      vertex(xP, getAltitude(xP, (z + 1) * TILE_SIZE), (z + 1) * TILE_SIZE);
    }
    endShape();
  }
}

function shipDisplay() {
  push();
  translate(ship.x, ship.y, ship.z);
  rotateY(ship.yaw); rotateX(ship.pitch);
  stroke(0);
  fill(240); beginShape(); vertex(-15, 10, 15); vertex(15, 10, 15); vertex(0, 10, -25); endShape(CLOSE);
  fill(200); beginShape(); vertex(0, -10, 5); vertex(-15, 10, 15); vertex(0, 10, -25); endShape(CLOSE);
  fill(180); beginShape(); vertex(0, -10, 5); vertex(15, 10, 15); vertex(0, 10, -25); endShape(CLOSE);
  fill(150); beginShape(); vertex(0, -10, 5); vertex(-15, 10, 15); vertex(15, 10, 15); endShape(CLOSE);
  pop();
}

function drawTrees() {
  trees.forEach(t => {
    if (dist(ship.x, ship.z, t.x, t.z) < 3000) {
        let y = getAltitude(t.x, t.z);
        push(); translate(t.x, y, t.z); fill(20, 100, 20); 
        t.type ? sphere(14) : cone(14, 35); pop();
    }
  });
}

function drawEnemies() {
  enemies.forEach(e => {
    push(); translate(e.x, e.y, e.z); fill(255, 0, 0); stroke(255);
    rotateY(frameCount * 0.1); box(30, 15, 30); translate(0, 10, 0); box(10, 20, 10);
    pop();
  });
}

function updateEnemies() {
  enemies.forEach(e => {
    e.x += e.vx; e.z += e.vz; e.y += sin(frameCount * 0.05 + e.id) * 2;
    if (abs(e.x - ship.x) > 5000) e.vx *= -1;
    if (abs(e.z - ship.z) > 5000) e.vz *= -1;
  });
}

function explosion(x, y, z) {
  for(let i=0; i<20; i++) particles.push({x: x, y: y, z: z, vx: random(-5,5), vy: random(-5,5), vz: random(-5,5), life: 200});
}

function resetGame() {
  ship.x = 400; ship.z = 400; ship.y = LAUNCHPAD_ALTITUDE - 20;
  ship.vx = ship.vy = ship.vz = 0;
}

function mousePressed() {
  // Check if the sketch is already in fullscreen
  let fs = fullscreen();
  if (!fs) {
    fullscreen(true);
  }

  // Handle Pointer Lock for 3D controls
  if (!document.pointerLockElement) {
    requestPointerLock();
  }

}

function windowResized() {
  // Resizes the canvas to the new browser dimensions
  resizeCanvas(windowWidth, windowHeight);
  
  // Optional: If you want to maintain a specific field of view
  // perspective(PI / 3.0, width / height, 0.1, 10000);
}