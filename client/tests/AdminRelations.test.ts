import { describe, it, expect } from 'vitest';
import { pickAimedNpc, NPC_AIM_HEIGHT } from '../src/engine/NpcAim';
import { toAdminRows } from '../src/ui/AdminRelationsPanel';

describe('pickAimedNpc', () => {
  const eye = { x: 100, y: NPC_AIM_HEIGHT, z: 130 };
  const lookNorth = { x: 0, y: 0, z: -1 }; // towards -Z
  const npcs = [
    { id: 'lao_wang', x: 100, y: 0, z: 124 },
    { id: 'chef_chen', x: 100, y: 0, z: 118 },
    { id: 'guard_zhang', x: 104, y: 0, z: 126 },
  ];

  it('picks the nearest NPC on the crosshair', () => {
    expect(pickAimedNpc(eye, lookNorth, npcs)).toBe('lao_wang');
  });

  it('ignores NPCs beside the view ray, behind the player and too far away', () => {
    expect(pickAimedNpc(eye, { x: 0, y: 0, z: 1 }, npcs)).toBeNull();
    expect(pickAimedNpc(eye, { x: 1, y: 0, z: 0 }, npcs)).toBeNull();
    expect(pickAimedNpc(eye, lookNorth, [{ id: 'far', x: 100, y: 0, z: 100 }])).toBeNull();
  });

  it('hits an NPC slightly off-centre and skips ones removed in the editor (NaN position)', () => {
    expect(pickAimedNpc(eye, lookNorth, [{ id: 'lao_wang', x: 100.6, y: 0, z: 124 }])).toBe('lao_wang');
    expect(pickAimedNpc(eye, lookNorth, [{ id: 'lao_wang', x: NaN, y: 0, z: NaN }])).toBeNull();
  });
});

describe('toAdminRows', () => {
  it('lists online players first and describes personal offsets', () => {
    const rows = toAdminRows([
      { player_id: 2, login: 'zoe', online: false, mianzi: 50, aggro: 0, mianzi_offset: 0, aggro_offset: 0 },
      { player_id: 3, login: 'boris', online: true, mianzi: 10, aggro: 90, mianzi_offset: -40, aggro_offset: 90 },
      { player_id: 1, login: 'alice', online: true, mianzi: 50, aggro: 0, mianzi_offset: 0, aggro_offset: 0 },
    ]);
    expect(rows.map((r) => r.login)).toEqual(['alice', 'boris', 'zoe']);
    expect(rows[1].note).toBe('личное: уважение −40, агрессия +90');
    expect(rows[0].note).toBe('');
  });
});
