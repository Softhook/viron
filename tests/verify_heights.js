
// Verification script to check if enemies are above terrain
function verifyEnemyHeights() {
    if (typeof enemyManager === 'undefined' || typeof terrain === 'undefined') {
        console.error("enemyManager or terrain not found");
        return;
    }

    const enemies = enemyManager.enemies;
    const flyingTypes = ['seeder', 'bomber', 'hunter', 'fighter', 'squid'];
    let issues = 0;

    enemies.forEach(e => {
        if (flyingTypes.includes(e.type)) {
            const gy = terrain.getAltitude(e.x, e.z);
            const clearance = gy - e.y;
            if (clearance < 0) {
                console.warn(`Issue: ${e.type} at (${Math.round(e.x)}, ${Math.round(e.z)}) is UNDER terrain! y: ${Math.round(e.y)}, gy: ${Math.round(gy)}`);
                issues++;
            }
        }
    });

    if (issues === 0) {
        console.log("Verification Passed: All flying enemies are above terrain.");
    } else {
        console.error(`Verification Failed: ${issues} enemies found under terrain.`);
    }
}

// Auto-run if possible or expose to console
if (typeof window !== 'undefined') {
    window.verifyEnemyHeights = verifyEnemyHeights;
}
