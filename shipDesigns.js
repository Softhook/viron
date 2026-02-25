// =============================================================================
// shipDesigns.js — Visual variants and flight settings for the player ship
//
// Defines a set of ship designs. Each entry includes:
//   • name: Human-readable name
//   • thrustAngle: Radians offset from straight-down (0 = Down, PI/4 = 45deg Back)
//   • draw: Geometry function that returns engine flame attachment points
// =============================================================================

const SHIP_DESIGNS = [
    // --- Design 0: Classic Basic Triangle ---
    {
        name: "Classic",
        thrustAngle: 0, // Fires directly underneath
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let nose = [0, 0, -32], tailL = [-16, 6, 12], tailR = [16, 6, 12], top = [0, -8, 12];
                drawFace([nose, tailL, tailR], [60, 60, 70]); // Bottom
                drawFace([nose, tailL, top], tintColor);       // Left side
                drawFace([nose, tailR, top], tintColor);       // Right side
                drawFace([tailL, tailR, top], dark);           // Rear

                // Cockpit window
                drawFace([[0, -2, -10], [4, -4, 2], [-4, -4, 2]], [100, 200, 255, 180]);
            }
            return [{ x: 0, y: 0, z: 12 }]; // Single central engine nozzle
        }
    },

    // --- Design 1: Multi-Role Fighter ---
    {
        name: "Fighter",
        thrustAngle: Math.PI / 4, // Fires diagonally backward
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let nose = [0, 0, -42];
                let bodyM_T = [0, -6, -10], bodyM_B = [0, 6, -10], bodyM_L = [-7, 0, -10], bodyM_R = [7, 0, -10];
                let bodyR_T = [0, -4, 22], bodyR_B = [0, 8, 22], bodyR_L = [-9, 2, 22], bodyR_R = [9, 2, 22];

                drawFace([nose, bodyM_T, bodyM_L], light);
                drawFace([nose, bodyM_T, bodyM_R], light);
                drawFace([nose, bodyM_B, bodyM_L], dark);
                drawFace([nose, bodyM_B, bodyM_R], dark);
                drawFace([bodyM_T, bodyR_T, bodyR_L, bodyM_L], tintColor);
                drawFace([bodyM_T, bodyR_T, bodyR_R, bodyM_R], tintColor);
                drawFace([bodyM_B, bodyR_B, bodyR_L, bodyM_L], dark);
                drawFace([bodyM_B, bodyR_B, bodyR_R, bodyM_R], dark);

                let wTipL = [-40, 14, 28], wTipR = [40, 14, 28];
                let wRootF_L = [-6, 0, -12], wRootF_R = [6, 0, -12], wRootR_L = [-8, 4, 18], wRootR_R = [8, 4, 18];
                drawFace([wRootF_L, wTipL, wRootR_L], tintColor);
                drawFace([wRootF_R, wTipR, wRootR_R], tintColor);
                drawFace([wRootF_L, wTipL, [-40, 15, 28], [-6, 2, -12]], dark);
                drawFace([wRootF_R, wTipR, [40, 15, 28], [6, 2, -12]], dark);

                const drawEngine = (ex, ey, ez) => {
                    let p1 = [ex - 4, ey - 4, ez - 8], p2 = [ex + 4, ey - 4, ez - 8], p3 = [ex + 4, ey + 4, ez - 8], p4 = [ex - 4, ey + 4, ez - 8];
                    let p5 = [ex - 4, ey - 4, ez + 8], p6 = [ex + 4, ey - 4, ez + 8], p7 = [ex + 4, ey + 4, ez + 8], p8 = [ex - 4, ey + 4, ez + 8];
                    drawFace([p1, p2, p3, p4], engineGray);
                    drawFace([p1, p2, p6, p5], engineGray);
                    drawFace([p3, p4, p8, p7], engineGray);
                    drawFace([p1, p5, p8, p4], engineGray);
                    drawFace([p2, p6, p7, p3], engineGray);
                };
                drawEngine(-13, 5, 18); drawEngine(13, 5, 18);

                drawFace([[-4, -4, -18], [4, -4, -18], [5, -6, 5], [-5, -6, 5]], [100, 200, 255, 180]);
                drawFace([[-4, -4, -18], [-5, -6, 5], [0, -6, -12]], [150, 220, 255, 180]);
                drawFace([[4, -4, -18], [5, -6, 5], [0, -6, -12]], [150, 220, 255, 180]);
            }
            return [{ x: -13, y: 5, z: 26 }, { x: 13, y: 5, z: 26 }];
        }
    },

    // --- Design 2: Interceptor ---
    {
        name: "Interceptor",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let nose = [0, 0, -55];
                let bodyM_T = [0, -4, -15], bodyM_B = [0, 4, -15], bodyM_L = [-5, 0, -15], bodyM_R = [5, 0, -15];
                let bodyR_T = [0, -6, 25], bodyR_B = [0, 6, 25], bodyR_L = [-8, 0, 25], bodyR_R = [8, 0, 25];

                drawFace([nose, bodyM_T, bodyM_L], light);
                drawFace([nose, bodyM_T, bodyM_R], light);
                drawFace([nose, bodyM_B, bodyM_L], dark);
                drawFace([nose, bodyM_B, bodyM_R], dark);
                drawFace([bodyM_T, bodyR_T, bodyR_L, bodyM_L], tintColor);
                drawFace([bodyM_T, bodyR_T, bodyR_R, bodyM_R], tintColor);
                drawFace([bodyM_B, bodyR_B, bodyR_L, bodyM_L], dark);
                drawFace([bodyM_B, bodyR_B, bodyR_R, bodyM_R], dark);

                let wTipL = [-35, 4, -10], wTipR = [35, 4, -10];
                let wRootF_L = [-7, 0, 5], wRootF_R = [7, 0, 5], wRootR_L = [-7, 0, 25], wRootR_R = [7, 0, 25];
                drawFace([wRootF_L, wTipL, wRootR_L], tintColor);
                drawFace([wRootF_R, wTipR, wRootR_R], tintColor);

                const drawCentralEngine = (ex, ey, ez) => {
                    let p1 = [ex - 6, ey - 6, ez], p2 = [ex + 6, ey - 6, ez], p3 = [ex + 6, ey + 6, ez], p4 = [ex - 6, ey + 6, ez];
                    let p5 = [ex - 6, ey - 6, ez + 15], p6 = [ex + 6, ey - 6, ez + 15], p7 = [ex + 6, ey + 6, ez + 15], p8 = [ex - 6, ey + 6, ez + 15];
                    drawFace([p1, p2, p3, p4], engineGray);
                    drawFace([p1, p2, p6, p5], engineGray);
                    drawFace([p3, p4, p8, p7], engineGray);
                    drawFace([p1, p5, p8, p4], engineGray);
                    drawFace([p2, p6, p7, p3], engineGray);
                    drawFace([p5, p6, p7, p8], [40, 40, 45]);
                };
                drawCentralEngine(0, 0, 20);

                drawFace([[-3, -3, -25], [3, -3, -25], [4, -5, -5], [-4, -5, -5]], [100, 200, 255, 180]);
                drawFace([[-3, -3, -25], [-4, -5, -5], [0, -5, -20]], [150, 220, 255, 180]);
                drawFace([[3, -3, -25], [4, -5, -5], [0, -5, -20]], [150, 220, 255, 180]);
            }
            return [{ x: 0, y: 0, z: 35 }];
        }
    },

    // --- Design 3: Heavy Tanker ---
    {
        name: "Heavy",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let fNose = [0, 0, -35];
                let f1 = [-12, -8, -15], f2 = [12, -8, -15], f3 = [12, 10, -15], f4 = [-12, 10, -15];
                let r1 = [-15, -10, 25], r2 = [15, -10, 25], r3 = [15, 12, 25], r4 = [-15, 12, 25];

                drawFace([fNose, f1, f2], light);
                drawFace([fNose, f2, f3], dark);
                drawFace([fNose, f3, f4], dark);
                drawFace([fNose, f4, f1], light);

                drawFace([f1, f2, r2, r1], tintColor);
                drawFace([f3, f4, r4, r3], dark);
                drawFace([f1, f4, r4, r1], tintColor);
                drawFace([f2, f3, r3, r2], tintColor);
                drawFace([r1, r2, r3, r4], dark);

                let wTipL = [-45, 2, 15], wTipR = [45, 2, 15];
                drawFace([[-12, 0, -5], wTipL, [-15, 0, 20]], tintColor);
                drawFace([[12, 0, -5], wTipR, [15, 0, 20]], tintColor);

                const drawEng = (ex, ey, ez) => {
                    let pts = [[-3, -3, -6], [3, -3, -6], [3, 3, -6], [-3, 3, -6], [-3, -3, 6], [3, -3, 6], [3, 3, 6], [-3, 3, 6]];
                    let shifted = pts.map(p => [p[0] + ex, p[1] + ey, p[2] + ez]);
                    drawFace([shifted[0], shifted[1], shifted[2], shifted[3]], engineGray);
                    drawFace([shifted[4], shifted[5], shifted[6], shifted[7]], engineGray);
                    drawFace([shifted[0], shifted[1], shifted[5], shifted[4]], engineGray);
                    drawFace([shifted[2], shifted[3], shifted[7], shifted[6]], engineGray);
                };
                drawEng(-15, 6, 20); drawEng(-22, 6, 20);
                drawEng(15, 6, 20); drawEng(22, 6, 20);

                drawFace([[-8, -8, -16], [8, -8, -16], [8, -10, -5], [-8, -10, -5]], [100, 200, 255, 180]);
            }
            return [
                { x: -15, y: 6, z: 26 }, { x: -22, y: 6, z: 26 },
                { x: 15, y: 6, z: 26 }, { x: 22, y: 6, z: 26 }
            ];
        }
    },

    // --- Design 4: Tri-Wing ---
    {
        name: "Tri-Wing",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let nose = [0, 0, -45];
                let bodyM_T = [0, -5, -10], bodyM_B = [0, 5, -10], bodyM_L = [-5, 0, -10], bodyM_R = [5, 0, -10];
                let bodyR_T = [0, -4, 20], bodyR_B = [0, 6, 20], bodyR_L = [-6, 0, 20], bodyR_R = [6, 0, 20];

                drawFace([nose, bodyM_T, bodyM_L], light);
                drawFace([nose, bodyM_T, bodyM_R], light);
                drawFace([bodyM_T, bodyR_T, bodyR_L, bodyM_L], tintColor);
                drawFace([bodyM_T, bodyR_T, bodyR_R, bodyM_R], tintColor);
                drawFace([bodyM_L, bodyR_L, bodyR_B, bodyM_B], dark);
                drawFace([bodyM_R, bodyR_R, bodyR_B, bodyM_B], dark);

                let topFin = [0, -35, 25];
                let leftWing = [-35, 8, 25];
                let rightWing = [35, 8, 25];
                drawFace([[0, -5, 0], topFin, [0, -4, 20]], tintColor);
                drawFace([[-5, 0, 0], leftWing, [-6, 0, 20]], tintColor);
                drawFace([[5, 0, 0], rightWing, [6, 0, 20]], tintColor);

                const dEng = (ex, ey, ez) => {
                    let pts = [[-3, -3, -5], [3, -3, -5], [3, 3, -5], [-3, 3, -5], [-3, -3, 5], [3, -3, 5], [3, 3, 5], [-3, 3, 5]];
                    let shifted = pts.map(p => [p[0] + ex, p[1] + ey, p[2] + ez]);
                    drawFace([shifted[0], shifted[1], shifted[2], shifted[3]], engineGray);
                    drawFace([shifted[4], shifted[5], shifted[6], shifted[7]], engineGray);
                    drawFace([shifted[0], shifted[1], shifted[5], shifted[4]], engineGray);
                    drawFace([shifted[2], shifted[3], shifted[7], shifted[6]], engineGray);
                };
                dEng(-10, -8, 15); dEng(10, -8, 15);
            }
            return [{ x: -10, y: -8, z: 20 }, { x: 10, y: -8, z: 20 }];
        }
    },

    // --- Design 5: Podracer ---
    {
        name: "Podracer",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                const drawPod = (offsetX) => {
                    let nose = [offsetX, 0, -45];
                    let b1 = [offsetX - 4, -4, -10], b2 = [offsetX + 4, -4, -10], b3 = [offsetX + 4, 4, -10], b4 = [offsetX - 4, 4, -10];
                    let r1 = [offsetX - 5, -5, 25], r2 = [offsetX + 5, -5, 25], r3 = [offsetX + 5, 5, 25], r4 = [offsetX - 5, 5, 25];
                    drawFace([nose, b1, b2], light);
                    drawFace([nose, b2, b3], dark);
                    drawFace([nose, b3, b4], dark);
                    drawFace([nose, b4, b1], light);
                    drawFace([b1, b2, r2, r1], tintColor);
                    drawFace([b3, b4, r4, r3], dark);
                    drawFace([b1, b4, r4, r1], tintColor);
                    drawFace([b2, b3, r3, r2], tintColor);
                };
                drawPod(-12); drawPod(12);

                drawFace([[-12, -2, 0], [12, -2, 0], [12, 2, 0], [-12, 2, 0]], engineGray);
                drawFace([[-4, -6, -5], [4, -6, -5], [5, -4, 15], [-5, -4, 15]], [100, 200, 255, 180]);
            }
            return [{ x: -12, y: 0, z: 25 }, { x: 12, y: 0, z: 25 }];
        }
    }
];
