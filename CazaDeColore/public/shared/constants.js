// constants.js — compartido entre servidor (Node, vía require) y cliente
// (navegador, vía <script>). Sin módulos ES para que funcione en ambos.

// Un solo personaje ("guardián felino"), recoloreado según el grupo que
// le toque. Ya no hay clases con stats distintos.
var GROUP_COLORS = [
	{ key: "red", name: "ROJO", hex: "#ff4d63" },
	{ key: "blue", name: "AZUL", hex: "#36a6ff" },
	{ key: "green", name: "VERDE", hex: "#3ddc84" },
	{ key: "yellow", name: "AMARILLO", hex: "#ffd23f" },
];

var PLAYER_STATS = { speed: 260, health: 100, damage: 18, defense: 0.0 };

var ARENA_CENTER = { x: 640, y: 360 };
var BASE_ARENA_HALF = { x: 560, y: 320 };
var VIEWPORT = { w: 1280, h: 720 };

var OBSTACLE_FRACTIONS = [
	// Búnker central y pilares del medio
	{ off: { x: 0.0, y: 0.0 }, size: { x: 44, y: 44 } },
	{ off: { x: -0.16, y: -0.14 }, size: { x: 85, y: 26 } },
	{ off: { x: 0.16, y: -0.14 }, size: { x: 85, y: 26 } },
	{ off: { x: -0.16, y: 0.14 }, size: { x: 85, y: 26 } },
	{ off: { x: 0.16, y: 0.14 }, size: { x: 85, y: 26 } },

	// Muros defensivos en los 4 cuadrantes
	{ off: { x: -0.42, y: -0.36 }, size: { x: 110, y: 28 } },
	{ off: { x: 0.42, y: -0.36 }, size: { x: 110, y: 28 } },
	{ off: { x: -0.42, y: 0.36 }, size: { x: 110, y: 28 } },
	{ off: { x: 0.42, y: 0.36 }, size: { x: 110, y: 28 } },

	// Barreras verticales de cobertura lateral
	{ off: { x: -0.38, y: 0.0 }, size: { x: 28, y: 90 } },
	{ off: { x: 0.38, y: 0.0 }, size: { x: 28, y: 90 } },
	{ off: { x: 0.0, y: -0.42 }, size: { x: 90, y: 28 } },
	{ off: { x: 0.0, y: 0.42 }, size: { x: 90, y: 28 } },

	// Pilares y parapetos exteriores
	{ off: { x: -0.68, y: -0.58 }, size: { x: 44, y: 44 } },
	{ off: { x: 0.68, y: -0.58 }, size: { x: 44, y: 44 } },
	{ off: { x: -0.68, y: 0.58 }, size: { x: 44, y: 44 } },
	{ off: { x: 0.68, y: 0.58 }, size: { x: 44, y: 44 } },

	// Muros protectores en zonas de paso
	{ off: { x: -0.65, y: -0.15 }, size: { x: 30, y: 70 } },
	{ off: { x: 0.65, y: -0.15 }, size: { x: 30, y: 70 } },
	{ off: { x: -0.65, y: 0.15 }, size: { x: 30, y: 70 } },
	{ off: { x: 0.65, y: 0.15 }, size: { x: 30, y: 70 } },

	// Postes limítrofes
	{ off: { x: 0.0, y: -0.74 }, size: { x: 50, y: 32 } },
	{ off: { x: 0.0, y: 0.74 }, size: { x: 50, y: 32 } },
	{ off: { x: -0.78, y: 0.0 }, size: { x: 32, y: 50 } },
	{ off: { x: 0.78, y: 0.0 }, size: { x: 32, y: 50 } },
];

// --- Ronda de cacería (reemplaza al campo de fuerza) ---
// Cada ROUND_DURATION segundos se reparten de nuevo los grupos/colores Y
// la cadena de objetivos (color i caza al color i+1, en círculo). Quien no
// haya golpeado a su color objetivo durante la ronda empieza a perder vida
// sin parar hasta que lo logre o muera.
var ROUND_DURATION = 90; // 1:30 (antes 2:00)
var ROUND_WARNING_TIME = 15;
var PENALTY_DAMAGE_PER_SEC = 14;

var POWERUP_LIFETIME = 15;
var POWERUP_SPAWN_MIN = 6;
var POWERUP_SPAWN_MAX = 11;
var POWERUP_MAX_ACTIVE = 4;
var SHIELD_DURATION = 8;
var HEAL_AMOUNT = 40;
var BOMB_MAX = 2;
var BOMB_RANGE_MIN = 90;
var BOMB_RANGE_MAX = 340;
var BOMB_MAX_CHARGE_TIME = 1.2;
var BOMB_RADIUS = 75;
var BOMB_DAMAGE = 45;

var PLAYER_RADIUS = 16;
var BULLET_SPEED = 700;
var BULLET_LIFE = 1.4;
var ROOM_MAX_PLAYERS = 100;

if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		GROUP_COLORS, PLAYER_STATS, ARENA_CENTER, BASE_ARENA_HALF, VIEWPORT,
		OBSTACLE_FRACTIONS, ROUND_DURATION, ROUND_WARNING_TIME, PENALTY_DAMAGE_PER_SEC,
		POWERUP_LIFETIME, POWERUP_SPAWN_MIN, POWERUP_SPAWN_MAX, POWERUP_MAX_ACTIVE,
		SHIELD_DURATION, HEAL_AMOUNT, BOMB_MAX, BOMB_RANGE_MIN, BOMB_RANGE_MAX,
		BOMB_MAX_CHARGE_TIME, BOMB_RADIUS, BOMB_DAMAGE, PLAYER_RADIUS, BULLET_SPEED,
		BULLET_LIFE, ROOM_MAX_PLAYERS,
	};
}
