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
  floorColor: 0x71767a,          // Базовый цвет пола мира
  stoneTileLightColor: 0x7a8085, // Светло-серый цвет светлых плиток (Stone_Light)
  stoneTileDarkColor: 0x71767a,  // Светло-серый цвет темных плиток (Stone_Dark)
  floorGridLine1: 0x71767a,      // Цвет основных линий сетки пола
  floorGridLine2: 0x71767a,      // Цвет дополнительных линий сетки пола

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
