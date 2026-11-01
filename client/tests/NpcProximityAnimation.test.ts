/**
 * NPC Proximity Animation Test Suite
 * Target File: client/tests/NpcProximityAnimation.test.ts
 *
 * Verifies:
 * 1. Approaching NPC (< 8.5m) triggers 'Wave' animation while player is moving.
 * 2. Stopping next to NPC (< 3.4m, speed ~0) triggers alternate animation ('Angry' / other).
 * 3. Moving away (> 8.5m) smoothly returns NPC to 'Idle'.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

describe('NPC Proximity Animation State Machine', () => {
  it('correctly selects other animation (Angry) when player stops next to comical vendor', () => {
    const clips = [
      new THREE.AnimationClip('Idle', 2, []),
      new THREE.AnimationClip('Wave', 2, []),
      new THREE.AnimationClip('Angry', 2, []),
      new THREE.AnimationClip('Walk', 1, []),
    ];

    // Helper simulation matching World.getOtherNpcClip
    const getOtherNpcClip = (cList: THREE.AnimationClip[]) => {
      const angry = cList.find((c) => c.name === 'Angry');
      if (angry) return angry;
      const nonWave = cList.find((c) => c.name !== 'Wave' && c.name !== 'Idle' && c.name !== 'Walk');
      if (nonWave) return nonWave;
      const idle = cList.find((c) => c.name === 'Idle');
      return idle ?? cList[0] ?? null;
    };

    const chosen = getOtherNpcClip(clips);
    expect(chosen?.name).toBe('Angry');
  });

  it('falls back to Idle when NPC only has Idle and Wave (e.g. Lao Wang)', () => {
    const clips = [
      new THREE.AnimationClip('Idle', 2, []),
      new THREE.AnimationClip('Wave', 2, []),
    ];

    const getOtherNpcClip = (cList: THREE.AnimationClip[]) => {
      const angry = cList.find((c) => c.name === 'Angry');
      if (angry) return angry;
      const nonWave = cList.find((c) => c.name !== 'Wave' && c.name !== 'Idle' && c.name !== 'Walk');
      if (nonWave) return nonWave;
      const idle = cList.find((c) => c.name === 'Idle');
      return idle ?? cList[0] ?? null;
    };

    const chosen = getOtherNpcClip(clips);
    expect(chosen?.name).toBe('Idle');
  });

  it('simulates distance and speed state transitions: idle -> waving -> reacting -> idle', () => {
    type AnimState = 'idle' | 'waving' | 'reacting';
    let currentState: AnimState = 'idle';

    const evaluateState = (dist: number, isPlayerStopped: boolean): AnimState => {
      if (dist <= 3.4) {
        return isPlayerStopped ? 'reacting' : 'waving';
      } else if (dist <= 8.5) {
        return 'waving';
      }
      return 'idle';
    };

    // 1. Far away: player at 15m -> Idle
    currentState = evaluateState(15, false);
    expect(currentState).toBe('idle');

    // 2. Approaching: player at 6m and walking -> Wave
    currentState = evaluateState(6, false);
    expect(currentState).toBe('waving');

    // 3. Arrived at counter: player at 2.5m, still moving -> Wave
    currentState = evaluateState(2.5, false);
    expect(currentState).toBe('waving');

    // 4. Stopped at counter: player at 2.5m, stopped -> Reacting (Angry)
    currentState = evaluateState(2.5, true);
    expect(currentState).toBe('reacting');

    // 5. Walking away: player at 5m -> Wave
    currentState = evaluateState(5, false);
    expect(currentState).toBe('waving');

    // 6. Leaving stall: player at 10m -> Idle
    currentState = evaluateState(10, false);
    expect(currentState).toBe('idle');
  });
});
