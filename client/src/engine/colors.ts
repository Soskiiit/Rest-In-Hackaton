/**
 * ============================================================================
 * SCENE COLORS (ЦВЕТА СЦЕНЫ)
 * ============================================================================
 * Здесь собраны все основные цвета сцены.
 * Вы можете быстро менять их прямо здесь!
 * Формат цвета: 0xRRGGBB (шестнадцатеричный HEX код).
 */

export const SCENE_COLORS = {
  // --- FLOOR & GROUND (ПОЛ) ---
  floorColor: 0x787878,          // Один цвет на весь пол мира
  floorGridLine1: 0xffffff,      // Цвет основных линий сетки пола
  floorGridLine2: 0xffffff,      // Цвет дополнительных линий сетки пола

  // --- SKY & FOG (НЕБО И ТУМАН) ---
  fogColor: 0x99b6c9,            // Цвет тумана и фона неба

  // --- LIGHTS (ОСВЕЩЕНИЕ) ---
  sunLightColor: 0x636363,       // Цвет главного верхнего света (солнце/луна)
  roomLightColor: 0xffffff,      // Цвет общего фонового света (ambient)
  skyLightColor: 0xffffff,       // Цвет света с неба (hemisphere sky)
  groundLightColor: 0xffffff,    // Цвет подсветки от земли (hemisphere ground)

  // --- LANTERNS (ФОНАРИ: ТОЛЬКО 1 ЦВЕТ КОРПУСА И 1 ЦВЕТ СВЕТА) ---
  lanternBodyColor: 0xdb4e0d,    // Оранжевый корпус фонаря
  lanternLightColor: 0xffbb4d,   // Желтый свет от фонаря

  // --- MARKET STALLS & TENTS (ПАЛАТКИ) ---
  tentRoofColor: 0xdb0000,       // 1. Цвет тканевого тента/крыши
  tentPoleColor: 0xc7c7c7,       // 2. Цвет палок/столбов, на которых держится тент
  tentBaseColor: 0xccae72,       // 3. Цвет основания стойки/прилавка

  // --- BUILDINGS & WALLS (СТЕНЫ И ЗДАНИЯ) ---
  wallBrickColor: 0x8b3a2b,      // Кирпичный цвет стен зданий (Terracotta / Red Brick)
};
