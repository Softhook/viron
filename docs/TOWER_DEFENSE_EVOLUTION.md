# Virus: Tower Defense Evolution Plan

This document outlines the proposed transformation of "Virus" (viron) from a level-based action game into a comprehensive tower defense experience.

## 1. Core Objective: Support the Sentinels
In this evolution, the **Sentinels (Jade Spires)** become the primary defense targets.

- **Vulnerability**: Sentinels start at 100% "Purity." If the virus consumes the tile beneath a Sentinel, its purity begins to drop.
- **Fail Condition**: The player loses if all Sentinels on the map reach 0% Purity and become "Corrupted."
- **Infection Spike**: A Corrupted Sentinel acts as a "Super Spreader," accelerating the viral spread in its vicinity until reclaimed.

## 2. Direction: The Strategic Architect
A mode focused on resource management, territory control, and tactical building placement.

### A. The "Lux" Economy
- **Purification Harvesting**: Every clean tile produces a small amount of "Lux" per second. A larger "clean" map provides more resources for building.
- **Viral Bounties**: Killing enemies or clearing infected trees grants immediate Lux bonuses.
- **Wave Tributes**: Intact Sentinels provide a large Lux bonus at the end of each wave.

### B. Construction: Seed-Pod Deployment
Buildings are not placed via a traditional menu; they are deployed from the player ship.
- **Build Menu**: Toggleable HUD menu showing available "Seeds."
- **Seed Pods**: The ship fires a Pod (Village, Wizard Tower, or Barrier) to a ground location.
- **Growth Phase**: Buildings take time to grow from seeds and are vulnerable to attack during this phase.

### C. Building Hierarchy
| Building | Cost | Unit Spawned | Role |
| :--- | :--- | :--- | :--- |
| **Village (Pagoda)** | 500 Lux | Villagers | Area denial, curing small clusters, planting crops. |
| **Wizard Tower** | 1500 Lux | Wizards | High-power artillery, 2x2 viral clearing, ground-enemy spells. |
| **Barrier Wall** | 200 Lux | N/A | Physical obstacle to block ground swarms (Crabs, Wolves). |

## 3. Wave Management: Viral Rifts
- **Wave-Based Flow**: Enemies arrive in scheduled waves of increasing intensity.
- **Viral Rifts**: Large purple rifts appear at the map's edge to signal wave starts.
- **Wave Forecast**: A "Threat Meter" in the HUD displays time until the next wave and expected enemy types.

## 4. Proposed UI & HUD Changes
- **Lux Counter**: Real-time display of current currency.
- **Build Hot-Bar**: Quick-select menu for building seeds.
- **Sentinel Status Icons**: Global tracker for Sentinel health/corruption status.
- **Wave Progress Bar**: Visual indicator of the remaining forces in the current wave.

---

### In Practice: The Gameplay Loop
1. **The Breather**: Between waves, focus on clearing residual virus to maximize Lux income.
2. **Expansion**: Deploy "Village Seeds" to create buffers around Sentinels.
3. **Defense**: As a wave begins, prioritize "Viral Rifts" with ship weapons while your Wizards handle the ground-based swarm.
4. **Triage**: If a Sentinel is under heavy attack, use "Barrier Spores" to slow the advance and personally intervene.
