// =============================================================================
// shipDesigns.js — Visual variants and flight settings for the player ship
//
// Defines a set of ship designs. Each entry includes:
//   • name: Human-readable name
//   • thrustAngle: Radians offset from straight-down (0 = Down, PI/4 = 45deg Back)
//   • draw: Geometry function that returns engine flame attachment points
// =============================================================================

const SHIP_DESIGNS = [
    // =========================================================================
    // HOVER / VTOL DESIGNS (Thrust Directly Down)
    // =========================================================================

    // --- Design 0: Classic ---
    {
        name: "Classic",
        role: "BALANCED MULTI-ROLE",
        desc: "A dependable workhorse with predictable handling and balanced VTOL output.",
        thrust: 0.45,
        turnRate: 0.04,
        pitchRate: 0.04,
        drag: 0.992,
        thrustAngle: 0,
        mass: 1.0,
        lift: 0.008,
        brakeRate: 0.96,
        missileCapacity: 1,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let nose = [0, 0, -32], tL = [-16, 6, 12], tR = [16, 6, 12], top = [0, -8, 12];
                drawFace([nose, tL, tR], dark);       // Bottom
                drawFace([nose, tL, top], tintColor); // Left
                drawFace([nose, tR, top], tintColor); // Right
                drawFace([tL, tR, top], [255, 0, 0]);        // Rear (Red)
                drawFace([[0, -2, -10], [4, -4, 2], [-4, -4, 2]], [100, 200, 255, 180]); // Glass
                // Ventral Engine Nozzle (Bottom Back)
                drawFace([[-4, 3, 4], [4, 3, 4], [4, 3, 8], [-4, 3, 8]], [40, 40, 45]);
            }
            return [{ x: 0, y: 3.5, z: 4 }];
        }
    },

    // --- Design 1: Sleek Classic ---
    {
        name: "Sleek Classic",
        role: "FAST SCOUT",
        desc: "Upgraded composites and weight-saving measures allow for higher cruising speeds.",
        thrust: 0.52,
        turnRate: 0.045,
        pitchRate: 0.045,
        drag: 0.994,
        thrustAngle: 0,
        mass: 0.8,
        lift: 0.012,
        brakeRate: 0.97,
        missileCapacity: 1,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                // Main Fuselage (Diamond/Sleek)
                let nose = [0, -2, -35], midL = [-12, 2, 0], midR = [12, 2, 0], midT = [0, -8, 0], midB = [0, 6, 0];
                let rearL = [-8, 2, 15], rearR = [8, 2, 15], rearT = [0, -4, 15], rearB = [0, 4, 15];

                // Front Section
                drawFace([nose, midT, midL], light);
                drawFace([nose, midT, midR], light);
                drawFace([nose, midB, midL], dark);
                drawFace([nose, midB, midR], dark);

                // Rear Section
                drawFace([midT, rearT, rearL, midL], tintColor);
                drawFace([midT, rearT, rearR, midR], tintColor);
                drawFace([midB, rearB, rearL, midL], dark);
                drawFace([midB, rearB, rearR, midR], dark);

                // Vertical Stabilizer (Tail Fin)
                drawFace([[0, -8, 2], [0, -18, 18], [0, -4, 15]], tintColor);

                // Wings (Small stubs)
                drawFace([midL, [-25, 4, 10], rearL], tintColor);
                drawFace([midR, [25, 4, 10], rearR], tintColor);

                // Rear Cap
                drawFace([rearT, rearL, rearB, rearR], [255, 0, 0]);

                // Cockpit
                drawFace([[0, -8, -15], [5, -6, -5], [-5, -6, -5], [0, -9, -10]], [100, 200, 255, 200]);
                drawFace([[0, -8, -15], [0, -9, -10], [5, -6, -5]], [255, 255, 255, 100]); // Highlight

                // Ventral Engine Nozzle
                drawFace([[-5, 4, 5], [5, 4, 5], [5, 4, 12], [-5, 4, 12]], [40, 40, 45]);
            }
            return [{ x: 0, y: 4.5, z: 8.5 }];
        }
    },

    // --- Design 2: Vindicator VTOL ---
    {
        name: "Vindicator VTOL",
        role: "HEAVY STABILIZED",
        desc: "Quad-pod pod engines provide massive lifting power at the cost of rotational inertia.",
        thrust: 0.65,
        turnRate: 0.025,
        pitchRate: 0.025,
        drag: 0.988,
        thrustAngle: 0,
        mass: 1.8,
        lift: 0.003,
        brakeRate: 0.92,
        missileCapacity: 3,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                // Main fuselage (blocky)
                let f1 = [-10, -5, -20], f2 = [10, -5, -20], f3 = [10, 5, -20], f4 = [-10, 5, -20];
                let f5 = [-12, -6, 15], f6 = [12, -6, 15], f7 = [12, 6, 15], f8 = [-12, 6, 15];
                // Bottom
                drawFace([f4, f3, f7, f8], dark);
                // Top
                drawFace([f1, f2, f6, f5], tintColor);
                // Sides
                drawFace([f1, f4, f8, f5], light);
                drawFace([f2, f3, f7, f6], dark);
                // Front/Back
                drawFace([f1, f2, f3, f4], light);
                drawFace([f5, f6, f7, f8], [255, 0, 0]); // Rear (Red)

                // Cockpit
                drawFace([[0, -6, -22], [4, -5, -12], [-4, -5, -12]], [200, 250, 255, 200]);

                // VTOL Pods
                const drPod = (sideX, sideZ) => {
                    let px = sideX * 18, pz = sideZ * 10;
                    let p = [[-4, -4, -4], [4, -4, -4], [4, 4, -4], [-4, 4, -4], [-5, -5, 4], [5, -5, 4], [5, 5, 4], [-5, 5, 4]].map(v => [v[0] + px, v[1], v[2] + pz]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[4], p[5], p[6], p[7]], [40, 40, 45]); // Base
                };
                drPod(1, 1); drPod(-1, 1); drPod(1, -1); drPod(-1, -1);
            }
            return [
                { x: 18, y: 5, z: 10 }, { x: -18, y: 5, z: 10 },
                { x: 18, y: 5, z: -6 }, { x: -18, y: 5, z: -6 }
            ];
        }
    },

    // --- Design 3: Nebula Lifter ---
    {
        name: "Nebula Lifter",
        role: "STABLE PLATFORM",
        desc: "Built for steady observation. Outriggers provide incredible hovering precision.",
        thrust: 0.48,
        turnRate: 0.03,
        pitchRate: 0.03,
        drag: 0.985,
        thrustAngle: 0,
        mass: 1.2,
        lift: 0.015,
        brakeRate: 0.98,
        missileCapacity: 1,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                // Central sphere-ish hub (octagonal)
                let pts = [];
                for (let i = 0; i < 8; i++) {
                    let a = (i / 8) * Math.PI * 2;
                    pts.push([Math.cos(a) * 15, -4, Math.sin(a) * 15]);
                    pts.push([Math.cos(a) * 15, 4, Math.sin(a) * 15]);
                }
                for (let i = 0; i < 8; i++) {
                    let i1 = i * 2, i2 = i * 2 + 1, i3 = ((i + 1) % 8) * 2, i4 = ((i + 1) % 8) * 2 + 1;
                    let col = (i % 2 === 0) ? tintColor : light;
                    if (i === 1 || i === 2) col = [255, 0, 0]; // Back segments (Red)
                    drawFace([pts[i1], pts[i3], pts[i4], pts[i2]], col);
                }
                // Cap
                drawFace([pts[0], pts[2], pts[4], pts[6], pts[8], pts[10], pts[12], pts[14]], dark);
                // Glass top
                drawFace([[0, -8, 0], [5, -4, 5], [-5, -4, 5], [0, -4, -7]], [100, 200, 255, 180]);
                // Outriggers
                const drO = (a) => {
                    let c = Math.cos(a), ss = Math.sin(a);
                    drawFace([[c * 15, 0, ss * 15], [c * 25, 2, ss * 25], [c * 22, 4, ss * 22]], engineGray);
                };
                for (let i = 0; i < 3; i++) drO((i / 3) * Math.PI * 2 + Math.PI / 6);
            }
            return [{ x: 0, y: 4, z: 0 }];
        }
    },

    // =========================================================================
    // DIAGONAL THRUST DESIGNS (45 Degree Back Tilt)
    // =========================================================================

    // --- Design 4: Sky Dart ---
    {
        name: "Sky Dart",
        role: "POINT INTERCEPTOR",
        desc: "Optimized for horizontal acceleration. Sharp nose, sharp turns, and high airspeed.",
        thrust: 0.58,
        turnRate: 0.035,
        pitchRate: 0.035,
        drag: 0.993,
        thrustAngle: Math.PI / 4,
        mass: 0.9,
        lift: 0.010,
        brakeRate: 0.95,
        missileCapacity: 2,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -45], b1 = [-5, -2, 0], b2 = [5, -2, 0], b3 = [0, 3, 5];
                drawFace([n, b1, b2], light); drawFace([n, b1, b3], tintColor); drawFace([n, b2, b3], tintColor);
                let r1 = [-8, 2, 25], r2 = [8, 2, 25], r3 = [0, 6, 25];
                drawFace([b1, r1, r2, b2], dark); drawFace([b1, r1, r3, b3], tintColor); drawFace([b2, r2, r3, b3], tintColor);
                drawFace([r1, r2, r3], [255, 0, 0]); // Rear cap (Red)
                // Engine
                drawFace([[-4, 2, 25], [4, 2, 25], [4, 6, 25], [-4, 6, 25]], engineGray);
            }
            return [{ x: 0, y: 4, z: 20 }];
        }
    },

    // --- Design 5: Falcon Interceptor ---
    {
        name: "Falcon Interceptor",
        role: "ELITE STRIKE",
        desc: "Advanced wing geometry and dual engines allow for aggressive combat maneuvering.",
        thrust: 0.54,
        turnRate: 0.05,
        pitchRate: 0.05,
        drag: 0.992,
        thrustAngle: Math.PI / 4,
        mass: 1.1,
        lift: 0.009,
        brakeRate: 0.96,
        missileCapacity: 2,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 2, -35], mT = [0, -4, 0], mL = [-6, 0, 5], mR = [6, 0, 5], mB = [0, 4, 10];
                drawFace([n, mB, mL], dark); drawFace([n, mB, mR], dark);
                drawFace([mT, mL, mB, mR], [255, 0, 0]); // Rear body (Red)
                // Wings
                const drW = (side) => {
                    let w1 = [side * 6, 0, 0], w2 = [side * 25, -2, 15], w3 = [side * 22, 2, 18], w4 = [side * 6, 2, 10];
                    drawFace([w1, w2, w3, w4], tintColor);
                };
                drW(1); drW(-1);
                // Dual Engines
                const drE = (side) => {
                    let ex = side * 5;
                    drawFace([[ex - 2, 2, 10], [ex + 2, 2, 10], [ex + 2, 5, 12], [ex - 2, 5, 12]], engineGray);
                };
                drE(1); drE(-1);
            }
            return [{ x: 5, y: 3.5, z: 7 }, { x: -5, y: 3.5, z: 7 }];
        }
    },

    // --- Design 6: Arrowhead SR ---
    {
        name: "Arrowhead SR",
        role: "SPEED DEMON",
        desc: "Maximum forward thrust with minimal drag. Best suited for high-speed hit and run.",
        thrust: 0.7,
        turnRate: 0.02,
        pitchRate: 0.02,
        drag: 0.995,
        thrustAngle: Math.PI / 4,
        mass: 0.7,
        lift: 0.005,
        brakeRate: 0.96,
        missileCapacity: 1,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 2, -40], l1 = [-25, 4, 15], r1 = [25, 4, 15], t1 = [0, -2, 10];
                drawFace([n, l1, t1], light); drawFace([n, r1, t1], light);
                drawFace([n, l1, r1], dark); // bottom
                drawFace([l1, r1, t1], [255, 0, 0]); // back (Red)
                // Intake
                drawFace([[0, -2, -10], [8, 0, -5], [-8, 0, -5]], [30, 30, 35]);
                // Wide Engine
                drawFace([[-12, 3, 14], [12, 3, 14], [12, 5, 14], [-12, 5, 14]], engineGray);
            }
            return [{ x: 0, y: 4, z: 11 }];
        }
    },

    // =========================================================================
    // JET / FORWARD THRUST DESIGNS (Thrust Straight Back)
    // =========================================================================

    // --- Design 7: Fighter ---
    {
        name: "Fighter",
        role: "SUPERIORITY FIGHTER",
        desc: "The standard by which all other fighters are measured. Combat-ready and agile.",
        thrust: 0.5,
        turnRate: 0.04,
        pitchRate: 0.04,
        drag: 0.992,
        thrustAngle: Math.PI / 2,
        mass: 1.0,
        lift: 0.008,
        brakeRate: 0.96,
        missileCapacity: 2,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -42];
                let mT = [0, -6, -10], mB = [0, 6, -10], mL = [-7, 0, -10], mR = [7, 0, -10];
                let rT = [0, -4, 22], rB = [0, 8, 22], rL = [-9, 2, 22], rR = [9, 2, 22];
                drawFace([n, mT, mL], light); drawFace([n, mT, mR], light);
                drawFace([n, mB, mL], dark); drawFace([n, mB, mR], dark);
                drawFace([mT, rT, rL, mL], tintColor); drawFace([mT, rT, rR, mR], tintColor);
                drawFace([mB, rB, rL, mL], dark); drawFace([mB, rB, rR, mR], dark);
                drawFace([rT, rB, rR], [255, 0, 0]); drawFace([rT, rB, rL], [255, 0, 0]); // Rear (Red)
                const drW = (side) => {
                    let rT = [side * -6, 0, -12], rB = [side * -8, 4, 18], tip = [side * -40, 14, 28], rBk = [side * -6, 4, -12];
                    drawFace([rT, rB, tip], tintColor); drawFace([rT, rBk, tip], tintColor);
                    drawFace([rB, rBk, tip], dark); drawFace([rT, rB, rBk], dark);
                };
                drW(1); drW(-1);
                const drE = (ex, ey, ez) => {
                    let p = [[-4, -4, -8], [4, -4, -8], [4, 4, -8], [-4, 4, -8], [-4, -4, 8], [4, -4, 8], [4, 4, 8], [-4, 4, 8]].map(v => [v[0] + ex, v[1] + ey, v[2] + ez]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], engineGray);
                };
                drE(-13, 5, 18); drE(13, 5, 18);
                drawFace([[-4, -4, -18], [4, -4, -18], [5, -1, -5], [-5, -1, -5]], [100, 200, 255, 180]);
                drawFace([[-4, -4, -18], [-5, -1, -5], [-7, 0, -10]], engineGray);
                drawFace([[4, -4, -18], [5, -1, -5], [7, 0, -10]], engineGray);
            }
            return [{ x: -13, y: 5, z: 18 }, { x: 13, y: 5, z: 18 }];
        }
    },

    // --- Design 8: Swift Scout ---
    {
        name: "Swift Scout",
        role: "LIGHT RECON",
        desc: "Lightweight chassis and high-output engines. Fragile but incredibly fast.",
        thrust: 0.6,
        turnRate: 0.06,
        pitchRate: 0.045,
        drag: 0.996,
        thrustAngle: Math.PI / 2,
        mass: 0.6,
        lift: 0.014,
        brakeRate: 0.98,
        missileCapacity: 1,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -32], cp = [0, -5, -8], mL = [-6, 2, 5], mR = [6, 2, 5], t = [0, 4, 15], b = [0, 6, 0];
                drawFace([n, cp, mL], light); drawFace([n, cp, mR], light);
                drawFace([n, mL, b], dark); drawFace([n, mR, b], dark);
                drawFace([cp, mL, t], dark); drawFace([cp, mR, t], dark);
                drawFace([mL, b, t], [255, 0, 0]); drawFace([mR, b, t], [255, 0, 0]); // Rear (Red)
                const drW = (side) => {
                    let rT1 = [side * 5, 1, -5], rT2 = [side * 6, 1, 12], rB1 = [side * 5, 3, -5], rB2 = [side * 6, 3, 12], tip = [side * 32, 2, 15];
                    drawFace([rT1, rT2, tip], light); drawFace([rB1, rB2, tip], dark);
                    drawFace([rT1, rB1, tip], light); drawFace([rT2, rB2, tip], dark);
                    drawFace([[side * 15, 1.8, 0], [side * 18, 1.8, 2], [side * 20, 2, 15], [side * 17, 2, 13]], [255, 255, 255, 200]);
                };
                drW(1); drW(-1);
                drawFace([[0, -5, -12], [3, -4, -4], [-3, -4, -4]], [100, 200, 255, 200]);
                drawFace([[0, -5, 5], [0, -18, 18], [0, 2, 15]], tintColor);
                drawFace([[-4, 2, 15], [4, 2, 15], [4, 5, 15], [-4, 5, 15]], engineGray);
            }
            return [{ x: 0, y: 3.5, z: 12 }];
        }
    },

    // --- Design 9: Viper Fighter ---
    {
        name: "Viper Fighter",
        role: "ADVANCED ATTACK",
        desc: "High-performance airframe. Aggressive and twitchy handling for expert pilots.",
        thrust: 0.55,
        turnRate: 0.07,
        pitchRate: 0.06,
        drag: 0.992,
        thrustAngle: Math.PI / 2,
        mass: 0.9,
        lift: 0.007,
        brakeRate: 0.97,
        missileCapacity: 3,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, -2, -45], bT = [0, -8, -5], bB = [0, 6, 15], bL = [-8, 0, 5], bR = [8, 0, 5];
                drawFace([n, bT, bL], light); drawFace([n, bT, bR], light);
                drawFace([n, bB, bL], dark); drawFace([n, bB, bR], dark);
                drawFace([bT, bB, bL], [255, 0, 0]); drawFace([bT, bB, bR], [255, 0, 0]); // Rear (Red)
                const drI = (side) => {
                    let p = [[side * 8, -4, -15], [side * 12, -2, -10], [side * 12, 4, -10], [side * 8, 4, -15]];
                    drawFace(p, [40, 40, 45]);
                    drawFace([p[0], p[1], [side * 12, -4, 10], [side * 8, -6, 5]], light);
                };
                drI(1); drI(-1);
                const drW = (side) => {
                    let rT1 = [side * 8, -2, -5], rT2 = [side * 10, 0, 25], rB1 = [side * 8, 2, -5], rB2 = [side * 10, 4, 25], tip = [side * 45, 6, 30];
                    drawFace([rT1, rT2, tip], tintColor); drawFace([rB1, rB2, tip], dark);
                    drawFace([rT1, rB1, tip], light); drawFace([rT2, rB2, tip], dark);
                    drawFace([tip, [side * 45, -10, 35], [side * 47, 6, 32]], light);
                    drawFace([[side * 20, 1, 10], [side * 25, 1, 12], [side * 25, 1, 18], [side * 20, 1, 16]], [255, 255, 255]);
                    drawFace([[side * 8, 0, 5], [side * 14, 4, 20], [side * 14, 4, 25], [side * 8, 0, 10]], engineGray);
                };
                drW(1); drW(-1);
                const drE = (side) => {
                    let ex = side * 14, p = [[-5, -5, -10], [5, -5, -10], [5, 5, -10], [-5, 5, -10], [-6, -6, 8], [6, -6, 8], [6, 6, 8], [-6, 6, 8]].map(v => [v[0] + ex, v[1] + 4, v[2] + 20]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], engineGray);
                };
                drE(1); drE(-1);
                drawFace([[0, -8, -12], [5, -6, 2], [-5, -6, 2], [0, -10, -5]], [100, 200, 255, 180]);
                drawFace([[-6, 2, 15], [6, 2, 15], [6, 6, 15], [-6, 6, 15]], [30, 30, 35]);
            }
            return [{ x: -14, y: 4, z: 22 }, { x: 14, y: 4, z: 22 }];
        }
    },

    // --- Design 10: Needle Interceptor ---
    {
        name: "Needle Interceptor",
        role: "EXPERIMENTAL RACER",
        desc: "Minimal profile, maximum output. Hard to fly, but impossible to catch in a straight line.",
        thrust: 0.75,
        turnRate: 0.035,
        pitchRate: 0.035,
        drag: 0.997,
        thrustAngle: Math.PI / 2,
        mass: 0.5,
        lift: 0.012,
        brakeRate: 0.99,
        missileCapacity: 1,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -60], neck = [0, 0, -20], base = [0, 0, 30], mT = [0, -4, 0], mB = [0, 4, 0], mL = [-4, 0, 0], mR = [4, 0, 0];
                drawFace([n, neck, mT], light); drawFace([n, neck, mL], light); drawFace([n, neck, mR], light); drawFace([n, neck, mB], dark);
                drawFace([neck, base, mT], light); drawFace([neck, base, mL], dark); drawFace([neck, base, mR], dark); drawFace([neck, base, mB], dark);
                const drW = (side) => {
                    let rT1 = [side * 4, -2, 5], rT2 = [side * 4, -2, 25], rB1 = [side * 4, 1, 5], rB2 = [side * 4, 1, 25], tip = [side * 35, -3, -15];
                    drawFace([rT1, rT2, tip], tintColor); drawFace([rB1, rB2, tip], dark);
                    drawFace([rT1, rB1, tip], light); drawFace([rT2, rB2, tip], dark);
                    drawFace([[side * 15, -2, 0], [side * 18, -2, 2], [side * 18, -2.5, -5], [side * 15, -2.5, -7]], [255, 50, 50]);
                };
                drW(1); drW(-1);
                let p = [[-7, -7, 0], [7, -7, 0], [7, 7, 0], [-7, 7, 0], [-9, -9, 15], [9, -9, 15], [9, 9, 15], [-9, 9, 15]].map(v => [v[0], v[1], v[2] + 20]);
                for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], [255, 0, 0]); // Rear (Red)
                drawFace([[0, -4, -15], [2, -3, -10], [-2, -3, -10]], [200, 255, 255]);
                drawFace([[-3, -4, 30], [3, -4, 30], [3, 4, 30], [-3, 4, 30]], engineGray);
            }
            return [{ x: 0, y: 0, z: 25 }];
        }
    },
];

