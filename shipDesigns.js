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
    // LEGACY DESIGNS (Original Low-Poly, Now Enclosed)
    // =========================================================================

    // --- Design 0: Classic Basic Triangle ---
    {
        name: "Classic (Legacy)",
        thrustAngle: 0,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let nose = [0, 0, -32], tL = [-16, 6, 12], tR = [16, 6, 12], top = [0, -8, 12];
                drawFace([nose, tL, tR], dark);       // Bottom
                drawFace([nose, tL, top], tintColor); // Left
                drawFace([nose, tR, top], tintColor); // Right
                drawFace([tL, tR, top], dark);        // Rear
                drawFace([[0, -2, -10], [4, -4, 2], [-4, -4, 2]], [100, 200, 255, 180]); // Glass
                // Engine nozzle
                drawFace([[-4, -1, 12], [4, -1, 12], [4, 3, 12], [-4, 3, 12]], engineGray);
                drawFace([[-3, 0, 14], [3, 0, 14], [3, 2, 14], [-3, 2, 14]], [50, 50, 55]);
            }
            return [{ x: 0, y: 1, z: 14 }];
        }
    },

    // --- Design 1: Multi-Role Fighter ---
    {
        name: "Fighter (Legacy)",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -42];
                let mT = [0, -6, -10], mB = [0, 6, -10], mL = [-7, 0, -10], mR = [7, 0, -10];
                let rT = [0, -4, 22], rB = [0, 8, 22], rL = [-9, 2, 22], rR = [9, 2, 22];

                // Fuselage front
                drawFace([n, mT, mL], light); drawFace([n, mT, mR], light);
                drawFace([n, mB, mL], dark); drawFace([n, mB, mR], dark);
                // Fuselage mid sections
                drawFace([mT, rT, rL, mL], tintColor); drawFace([mT, rT, rR, mR], tintColor);
                drawFace([mB, rB, rL, mL], dark); drawFace([mB, rB, rR, mR], dark);
                drawFace([rT, rB, rR], dark); drawFace([rT, rB, rL], dark); // Rear cap

                // Solid wings (4 faces each)
                const drW = (side) => {
                    let rT = [side * -6, 0, -12], rB = [side * -8, 4, 18], tip = [side * -40, 14, 28], rBk = [side * -6, 4, -12];
                    drawFace([rT, rB, tip], tintColor);
                    drawFace([rT, rBk, tip], tintColor);
                    drawFace([rB, rBk, tip], dark);
                    drawFace([rT, rB, rBk], dark);
                };
                drW(1); drW(-1);

                const drE = (ex, ey, ez) => {
                    let p = [[-4, -4, -8], [4, -4, -8], [4, 4, -8], [-4, 4, -8], [-4, -4, 8], [4, -4, 8], [4, 4, 8], [-4, 4, 8]].map(v => [v[0] + ex, v[1] + ey, v[2] + ez]);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], engineGray);
                    drawFace([p[0], p[1], p[5], p[4]], engineGray); drawFace([p[2], p[3], p[7], p[6]], engineGray);
                    drawFace([p[0], p[4], p[7], p[3]], engineGray); drawFace([p[1], p[5], p[6], p[2]], engineGray);
                };
                drE(-13, 5, 18); drE(13, 5, 18);
                drawFace([[-4, -4, -18], [4, -4, -18], [5, -1, -5], [-5, -1, -5]], [100, 200, 255, 180]); // Glass top
                drawFace([[-4, -4, -18], [-5, -1, -5], [-7, 0, -10]], engineGray); // Glass side left
                drawFace([[4, -4, -18], [5, -1, -5], [7, 0, -10]], engineGray); // Glass side right
            }
            return [{ x: -13, y: 5, z: 26 }, { x: 13, y: 5, z: 26 }];
        }
    },

    // --- Design 2: Interceptor ---
    {
        name: "Interceptor (Legacy)",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -55], mT = [0, -4, -15], mB = [0, 4, -15], mL = [-5, 0, -15], mR = [5, 0, -15];
                let rT = [0, -6, 25], rB = [0, 6, 25], rL = [-8, 0, 25], rR = [8, 0, 25];
                drawFace([n, mT, mL], light); drawFace([n, mT, mR], light);
                drawFace([n, mB, mL], dark); drawFace([n, mB, mR], dark);
                drawFace([mT, rT, rL, mL], tintColor); drawFace([mT, rT, rR, mR], tintColor);
                drawFace([mB, rB, rL, mL], dark); drawFace([mB, rB, rR, mR], dark);
                drawFace([rT, rB, rL, rR], dark); // cap

                // Solid wings
                const drW = (side) => {
                    let rF = [side * 7, 0, 5], rR = [side * 7, 0, 25], tip = [side * 35, 4, -10], rB = [side * 7, 4, 15];
                    drawFace([rF, rR, tip], tintColor);
                    drawFace([rF, rB, tip], tintColor);
                    drawFace([rR, rB, tip], dark);
                    drawFace([rF, rR, rB], dark);
                };
                drW(1); drW(-1);

                const drE = (ex, ey, ez) => {
                    let p = [[-6, -6, 0], [6, -6, 0], [6, 6, 0], [-6, 6, 0], [-6, -6, 15], [6, -6, 15], [6, 6, 15], [-6, 6, 15]].map(v => [v[0] + ex, v[1] + ey, v[2] + ez]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], [40, 40, 45]);
                };
                drE(0, 0, 20);
                drawFace([[-3, -3, -25], [3, -3, -25], [4, -5, -5], [-4, -5, -5]], [100, 200, 255, 180]);
            }
            return [{ x: 0, y: 0, z: 35 }];
        }
    },

    // --- Design 3: Heavy Tanker ---
    {
        name: "Heavy (Legacy)",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -35];
                let f = [[-12, -8, -15], [12, -8, -15], [12, 10, -15], [-12, 10, -15]];
                let r = [[-15, -10, 25], [15, -10, 25], [15, 12, 25], [-15, 12, 25]];
                drawFace([n, f[0], f[1]], light); drawFace([n, f[1], f[2]], dark);
                drawFace([n, f[2], f[3]], dark); drawFace([n, f[3], f[0]], light);
                for (let i = 0; i < 4; i++) drawFace([f[i], f[(i + 1) % 4], r[(i + 1) % 4], r[i]], (i == 0 || i == 3) ? light : dark);
                drawFace([r[0], r[1], r[2], r[3]], dark); // cap

                // Solid wings
                const drW = (side) => {
                    let rF = [side * 12, 0, -5], rR = [side * 15, 0, 20], tip = [side * 45, 2, 15], rB = [side * 14, 4, 10];
                    drawFace([rF, rR, tip], tintColor);
                    drawFace([rF, rB, tip], tintColor);
                    drawFace([rR, rB, tip], dark);
                    drawFace([rF, rR, rB], dark);
                };
                drW(1); drW(-1);

                const drE = (ex, ey, ez) => {
                    let p = [[-3, -3, -6], [3, -3, -6], [3, 3, -6], [-3, 3, -6], [-3, -3, 6], [3, -3, 6], [3, 3, 6], [-3, 3, 6]].map(v => [v[0] + ex, v[1] + ey, v[2] + ez]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], engineGray);
                };
                drE(-15, 6, 20); drE(15, 6, 20);
                drawFace([[-8, -8, -16], [8, -8, -16], [8, -10, -5], [-8, -10, -5]], [100, 200, 255, 180]);
            }
            return [{ x: -15, y: 6, z: 26 }, { x: 15, y: 6, z: 26 }];
        }
    },

    // --- Design 4: Tri-Wing ---
    {
        name: "Tri-Wing (Legacy)",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -45], m = [[0, -5, -10], [0, 5, -10], [-5, 0, -10], [5, 0, -10]], r = [[0, -4, 20], [0, 6, 20], [-6, 0, 20], [6, 0, 20]];
                drawFace([n, m[0], m[2]], light); drawFace([n, m[0], m[3]], light);
                drawFace([n, m[1], m[2]], dark); drawFace([n, m[1], m[3]], dark);
                for (let i = 0; i < 4; i++) drawFace([m[i], m[(i + 1) % 4], r[(i + 1) % 4], r[i]], tintColor);
                drawFace([r[0], r[1], r[2], r[3]], dark); // cap

                // Solid fins
                const drW = (side, angle) => {
                    let sa = Math.sin(angle), ca = Math.cos(angle);
                    let r1 = [ca * 5, sa * 5, 0], r2 = [ca * 6, sa * 6, 20], tip = [ca * 35, sa * 35, 25], r3 = [ca * 5, sa * 8, 10];
                    drawFace([r1, r2, tip], tintColor);
                    drawFace([r1, r3, tip], tintColor);
                    drawFace([r2, r3, tip], dark);
                    drawFace([r1, r2, r3], dark);
                };
                drW(1, -Math.PI / 2); drW(-1, Math.PI / 4); drW(1, 3 * Math.PI / 4);

                // Add engine models for Tri-Wing
                const drE = (ex, ey, ez) => {
                    let p = [[-4, -4, -4], [4, -4, -4], [4, 4, -4], [-4, 4, -4], [-4, -4, 4], [4, -4, 4], [4, 4, 4], [-4, 4, 4]].map(v => [v[0] + ex, v[1] + ey, v[2] + ez]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], engineGray);
                    // Connection strut
                    drawFace([[0, 0, ez], [ex, ey, ez], [ex, ey, ez + 2], [0, 0, ez + 2]], engineGray);
                };
                drE(-8, 6, 20); drE(8, 6, 20);
            }
            return [{ x: -8, y: 6, z: 24 }, { x: 8, y: 6, z: 24 }];
        }
    },

    // --- Design 5: Podracer ---
    {
        name: "Podracer (Legacy)",
        thrustAngle: Math.PI / 4,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                const drP = (ox) => {
                    let n = [ox, 0, -45], b = [[ox - 4, -4, -10], [ox + 4, -4, -10], [ox + 4, 4, -10], [ox - 4, 4, -10]], r = [[ox - 5, -5, 25], [ox + 5, -5, 25], [ox + 5, 5, 25], [ox - 5, 5, 25]];
                    drawFace([n, b[0], b[1]], light); drawFace([n, b[1], b[2]], dark); drawFace([n, b[2], b[3]], dark); drawFace([n, b[3], b[0]], light);
                    for (let i = 0; i < 4; i++) drawFace([b[i], b[(i + 1) % 4], r[(i + 1) % 4], r[i]], tintColor);
                    drawFace([r[0], r[1], r[2], r[3]], dark);
                };
                drP(-12); drP(12);
                let conP = [[-12, -2, 0], [12, -2, 0], [12, 2, 0], [-12, 2, 0], [-12, -2, 2], [12, -2, 2], [12, 2, 2], [-12, 2, 2]];
                for (let i = 0; i < 4; i++) drawFace([conP[i], conP[(i + 1) % 4], conP[(i + 1) % 4 + 4], conP[i + 4]], engineGray);
                drawFace([conP[0], conP[1], conP[2], conP[3]], engineGray); drawFace([conP[4], conP[5], conP[6], conP[7]], engineGray);
                drawFace([[-4, -6, -5], [4, -6, -5], [5, -4, 15], [-5, -4, 15]], [100, 200, 255, 180]);
            }
            return [{ x: -12, y: 0, z: 25 }, { x: 12, y: 0, z: 25 }];
        }
    },

    // =========================================================================
    // NEW HIGH-DETAIL DESIGNS (Properly Enclosed Solids)
    // =========================================================================

    // --- Design 6: Classic "Swift Scout" ---
    {
        name: "Swift Scout",
        thrustAngle: 0,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -32], cp = [0, -5, -8], mL = [-6, 2, 5], mR = [6, 2, 5], t = [0, 4, 15], b = [0, 6, 0];
                drawFace([n, cp, mL], light); drawFace([n, cp, mR], light);
                drawFace([n, mL, b], dark); drawFace([n, mR, b], dark);
                drawFace([cp, mL, t], dark); drawFace([cp, mR, t], dark);
                drawFace([mL, b, t], dark); drawFace([mR, b, t], dark);

                const drW = (side) => {
                    let rT1 = [side * 5, 1, -5], rT2 = [side * 6, 1, 12], rB1 = [side * 5, 3, -5], rB2 = [side * 6, 3, 12], tip = [side * 32, 2, 15];
                    drawFace([rT1, rT2, tip], light); drawFace([rB1, rB2, tip], dark);
                    drawFace([rT1, rB1, tip], light); drawFace([rT2, rB2, tip], dark);
                    drawFace([[side * 15, 1.8, 0], [side * 18, 1.8, 2], [side * 20, 2, 15], [side * 17, 2, 13]], [255, 255, 255, 200]);
                };
                drW(1); drW(-1);
                drawFace([[0, -5, -12], [3, -4, -4], [-3, -4, -4]], [100, 200, 255, 200]);
                drawFace([[0, -5, 5], [0, -18, 18], [0, 2, 15]], tintColor);
                // Engine nozzle
                drawFace([[-3, 2, 15], [3, 2, 15], [3, 5, 15], [-3, 5, 15]], engineGray);
            }
            return [{ x: 0, y: 3.5, z: 16 }];
        }
    },

    // --- Design 7: "Viper Fighter" ---
    {
        name: "Viper Fighter",
        thrustAngle: Math.PI / 10,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, -2, -45], bT = [0, -8, -5], bB = [0, 6, 15], bL = [-8, 0, 5], bR = [8, 0, 5];
                drawFace([n, bT, bL], light); drawFace([n, bT, bR], light);
                drawFace([n, bB, bL], dark); drawFace([n, bB, bR], dark);
                drawFace([bT, bB, bL], dark); drawFace([bT, bB, bR], dark); // closing body

                const drI = (side) => {
                    let p = [[side * 8, -4, -15], [side * 12, -2, -10], [side * 12, 4, -10], [side * 8, 4, -15]];
                    drawFace(p, [40, 40, 45]);
                    drawFace([p[0], p[1], [side * 12, -4, 10], [side * 8, -6, 5]], light);
                };
                drI(1); drI(-1);
                const drW = (side) => {
                    let rT1 = [side * 8, -2, -5], rT2 = [side * 10, 0, 25], rB1 = [side * 8, 2, -5], rB2 = [side * 10, 4, 25], tip = [side * 45, 6, 30];
                    drawFace([rT1, rT2, tip], tintColor); drawFace([rB1, rB2, tip], dark);
                    drawFace([rT1, rB1, tip], light); drawFace([rT2, rB2, tip], dark); // Enclosed wing
                    drawFace([tip, [side * 45, -10, 35], [side * 47, 6, 32]], light);
                    drawFace([[side * 20, 1, 10], [side * 25, 1, 12], [side * 25, 1, 18], [side * 20, 1, 16]], [255, 255, 255]);
                    // Engine strut
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
            }
            return [{ x: -14, y: 4, z: 28 }, { x: 14, y: 4, z: 28 }];
        }
    },

    // --- Design 8: "Needle Interceptor" ---
    {
        name: "Needle Interceptor",
        thrustAngle: Math.PI / 8,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let n = [0, 0, -60], neck = [0, 0, -20], base = [0, 0, 30], mT = [0, -4, 0], mB = [0, 4, 0], mL = [-4, 0, 0], mR = [4, 0, 0];
                drawFace([n, neck, mT], light); drawFace([n, neck, mL], light); drawFace([n, neck, mR], light); drawFace([n, neck, mB], dark);
                drawFace([neck, base, mT], light); drawFace([neck, base, mL], dark); drawFace([neck, base, mR], dark); drawFace([neck, base, mB], dark);

                const drW = (side) => {
                    let rT1 = [side * 4, -2, 5], rT2 = [side * 4, -2, 25], rB1 = [side * 4, 1, 5], rB2 = [side * 4, 1, 25], tip = [side * 35, -3, -15];
                    drawFace([rT1, rT2, tip], tintColor); drawFace([rB1, rB2, tip], dark);
                    drawFace([rT1, rB1, tip], light); drawFace([rT2, rB2, tip], dark); // Enclosed wing
                    drawFace([[side * 15, -2, 0], [side * 18, -2, 2], [side * 18, -2.5, -5], [side * 15, -2.5, -7]], [255, 50, 50]);
                };
                drW(1); drW(-1);
                let p = [[-7, -7, 0], [7, -7, 0], [7, 7, 0], [-7, 7, 0], [-9, -9, 15], [9, -9, 15], [9, 9, 15], [-9, 9, 15]].map(v => [v[0], v[1], v[2] + 20]);
                for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], [20, 20, 25]);
                drawFace([[0, -4, -15], [2, -3, -10], [-2, -3, -10]], [200, 255, 255]);
            }
            return [{ x: 0, y: 0, z: 35 }];
        }
    },

    // --- Design 9: "Behemoth" Heavy ---
    {
        name: "Behemoth",
        thrustAngle: Math.PI / 6,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let f = [[-12, -10, -25], [12, -10, -25], [12, 12, -25], [-12, 12, -25]], r = [[-15, -12, 30], [15, -12, 30], [15, 14, 30], [-15, 14, 30]];
                drawFace([f[0], f[1], f[2], f[3]], light); drawFace([r[0], r[1], r[2], r[3]], dark);
                for (let i = 0; i < 4; i++) drawFace([f[i], f[(i + 1) % 4], r[(i + 1) % 4], r[i]], tintColor);

                const drW = (side) => {
                    let rT1 = [side * 12, 0, -10], rT2 = [side * 15, 0, 20], rB1 = [side * 12, 6, -10], rB2 = [side * 15, 6, 20], tip = [side * 55, 4, 15];
                    drawFace([rT1, rT2, tip], tintColor); drawFace([rB1, rB2, tip], dark);
                    drawFace([rB1, rT1, tip], light); drawFace([rB2, rT2, tip], dark); // Enclosed wing
                    for (let i = 0; i < 3; i++) drawFace([[side * 30, 1.5, 5 + i * 8], [side * 33, 1.5, 7 + i * 8], [side * 33, 1.5, 11 + i * 8]], [255, 200, 0]);
                    // Engine strut
                    drawFace([[side * 15, 8, 20], [side * 18, 8, 20], [side * 18, 8, 22], [side * 15, 8, 22]], engineGray);
                };
                drW(1); drW(-1);
                const drE = (ex) => {
                    let p = [[-4, -4, -8], [4, -4, -8], [4, 4, -8], [-4, 4, -8], [-5, -5, 8], [5, -5, 8], [5, 5, 8], [-5, 5, 8]].map(v => [v[0] + ex, v[1] + 8, v[2] + 20]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], engineGray);
                };
                drE(-18); drE(18);
                drawFace([[-10, -10, -20], [10, -10, -20], [8, -14, -10], [-8, -14, -10]], [100, 240, 255, 200]);
            }
            return [{ x: -18, y: 8, z: 28 }, { x: 18, y: 8, z: 28 }];
        }
    },

    // --- Design 10: "Valkyrie" Tri-Wing ---
    {
        name: "Valkyrie",
        thrustAngle: Math.PI / 6,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                let p = [[-6, -6, -15], [6, -6, -15], [6, 6, -15], [-6, 6, -15], [-8, -8, 20], [8, -8, 20], [8, 8, 20], [-8, 8, 20]];
                for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], light);
                drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], dark);

                const drV = (angle) => {
                    let sa = Math.sin(angle), ca = Math.cos(angle);
                    let th = 1.5; // thickness
                    let rT1 = [ca * 5 - sa * th, sa * 5 + ca * th, -5], rT2 = [ca * 7 - sa * th, sa * 7 + ca * th, 15];
                    let rB1 = [ca * 5 + sa * th, sa * 5 - ca * th, -5], rB2 = [ca * 7 + sa * th, sa * 7 - ca * th, 15];
                    let tip = [ca * 42, sa * 42, 25];
                    drawFace([rT1, rT2, tip], tintColor); drawFace([rB1, rB2, tip], dark);
                    drawFace([rT1, rB1, tip], light); drawFace([rT2, rB2, tip], dark); // Enclosed wing
                    drawFace([[ca * 20, sa * 20, 10], [ca * 25, sa * 25, 12], [ca * 24 - sa * 5, sa * 24 + ca * 5, 12]], [255, 255, 255]);
                };
                drV(-Math.PI / 2); drV(Math.PI / 4); drV(3 * Math.PI / 4);
                const drE = (ex, ey) => {
                    let p = [[-4, -4, -5], [4, -4, -5], [4, 4, -5], [-4, 4, -5], [-5, -5, 5], [5, -5, 5], [5, 5, 5], [-5, 5, 5]].map(v => [v[0] + ex, v[1] + ey, v[2] + 10]);
                    for (let i = 0; i < 4; i++) drawFace([p[i], p[(i + 1) % 4], p[(i + 1) % 4 + 4], p[i + 4]], engineGray);
                    drawFace([p[0], p[1], p[2], p[3]], engineGray); drawFace([p[4], p[5], p[6], p[7]], engineGray);
                };
                drE(-12, 10); drE(12, 10);
                // Engine struts for Valkyrie
                drawFace([[-6, 6, 10], [-12, 10, 10], [-12, 10, 12], [-6, 6, 12]], engineGray);
                drawFace([[6, 6, 10], [12, 10, 10], [12, 10, 12], [6, 6, 12]], engineGray);
                drawFace([[0, -8, -10], [4, -6, 0], [-4, -6, 0], [0, -10, -5]], [200, 255, 255, 180]);
            }
            return [{ x: -12, y: 10, z: 15 }, { x: 12, y: 10, z: 15 }];
        }
    },

    // --- Design 11: "Star-Racer" Podracer ---
    {
        name: "Star-Racer",
        thrustAngle: Math.PI / 12,
        draw: function (drawFace, tintColor, engineGray, light, dark, pushing, s, transform) {
            if (drawFace) {
                const drP = (side) => {
                    let ox = side * 18, n = [ox, 0, -45], p = [], p2 = [];
                    for (let i = 0; i < 6; i++) {
                        let a = i * Math.PI / 3;
                        p.push([ox + Math.cos(a) * 6, Math.sin(a) * 6, -15]);
                        p2.push([ox + Math.cos(a) * 6, Math.sin(a) * 6, 25]);
                    }
                    for (let i = 0; i < 6; i++) {
                        drawFace([n, p[i], p[(i + 1) % 6]], [50, 50, 55]);
                        drawFace([p[i], p[(i + 1) % 6], p2[(i + 1) % 6], p2[i]], (i % 2 == 0) ? tintColor : dark);
                    }
                    drawFace([p[0], p[1], p[2], p[3], p[4], p[5]], [50, 50, 55]); // Front cap
                    drawFace([p2[0], p2[1], p2[2], p2[3], p2[4], p2[5]], dark); // Rear cap
                    drawFace([[ox, -6, 0], [ox, -15, 20], [ox, -6, 20]], tintColor);
                };
                drP(1); drP(-1);
                let c = [[-18, 0, 0], [18, 0, 0], [18, 3, 0], [-18, 3, 0], [-18, 0, 2], [18, 0, 2], [18, 3, 2], [-18, 3, 2]];
                for (let i = 0; i < 4; i++) drawFace([c[i], c[(i + 1) % 4], c[(i + 1) % 4 + 4], c[i + 4]], [100, 200, 255, 200]);
                drawFace([c[0], c[1], c[2], c[3]], [100, 200, 255, 200]); drawFace([c[4], c[5], c[6], c[7]], [100, 200, 255, 200]);
                drawFace([[0, -10, 15], [-5, -6, 10], [5, -6, 10], [0, -2, 25]], dark); // Cockpit base
                drawFace([[0, -10, 15], [-5, -6, 10], [-3, -8, 12]], [150, 220, 255]); // Glass panel L
                drawFace([[0, -10, 15], [5, -6, 10], [3, -8, 12]], [150, 220, 255]); // Glass panel R
            }
            return [{ x: -18, y: 0, z: 25 }, { x: 18, y: 0, z: 25 }];
        }
    }
];
