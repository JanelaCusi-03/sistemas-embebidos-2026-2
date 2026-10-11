// server.js — Caza de Colores. Un proceso Node sirve el cliente HTML5 estático
// y corre un WebSocket server autoritativo. Sin campo de fuerza: en su
// lugar, cada ROUND_DURATION segundos se reparten de nuevo los colores de
// cuerpo y, de forma INDIVIDUAL por jugador (no por grupo), un color a
// eliminar entre los demás en juego. Así, dos jugadores del mismo color de
// cuerpo pueden tener presas distintas. Si a un jugador se le acaban los
// rivales de su color objetivo antes de que termine la ronda, se le
// reasigna al instante un nuevo color propio y un nuevo objetivo (ver
// checkOrphanedTargets/reassignOrphanedPlayer). Quien no golpeó a su color
// objetivo en la ronda empieza a perder vida sin parar. Solo puedes hacerle
// daño a tu color objetivo — a nadie más.

const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const C = require(path.join(__dirname, "public", "shared", "constants.js"));

const PORT = process.env.PORT || 3000;
const TICK_MS = 50; // 20 ticks/seg
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const rooms = new Map();
let nextGlobalId = 1;

function genRoomCode() {
	let code;
	do {
		code = "";
		for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
	} while (rooms.has(code));
	return code;
}

function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
	const msg = JSON.stringify(obj);
	for (const p of room.players.values()) if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
}

function shuffle(arr) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

// Reparte N ids en como máximo 4 grupos, lo más parejo posible: el
// "sobrante" de N/4 se distribuye de a uno extra por grupo.
// Devuelve un array de arrays de ids (un array por color usado).
function distributeIntoGroups(ids) {
	const n = ids.length;
	const numColors = Math.min(4, Math.max(1, n));
	const base = Math.floor(n / numColors);
	const remainder = n % numColors;
	const shuffled = shuffle([...ids]);
	const groups = [];
	let idx = 0;
	for (let c = 0; c < numColors; c++) {
		const size = base + (c < remainder ? 1 : 0);
		groups.push(shuffled.slice(idx, idx + size));
		idx += size;
	}
	return groups;
}

// ---------------------------------------------------------------- ROOM

class Room {
	constructor(code) {
		this.code = code;
		this.players = new Map();
		this.bullets = [];
		this.bombs = [];
		this.powerups = [];
		this.nextEntityId = 1;
		this.started = false;
		this.matchOver = false;
		this.winnerId = -1;
		this.eliminationOrder = [];

		this.arenaHalf = { ...C.BASE_ARENA_HALF };
		this.arena = null;
		this.obstacles = [];

		this.roundTimer = C.ROUND_DURATION;
		this.roundWarned = false;
		this.roundNumber = 0;

		this.powerupSpawnTimer = 4;
		this.hostId = null;
	}

	lobbyList() {
		return [...this.players.values()].map((p) => ({
			id: p.id,
			name: p.name,
			isHost: p.id === this.hostId,
			isBot: !!p.isBot,
		}));
	}

	computeArena() {
		const n = Math.max(this.players.size, 1);
		const scale = Math.min(5, Math.max(1, Math.sqrt(Math.max(n, 2) / 6)));
		this.arenaHalf = { x: C.BASE_ARENA_HALF.x * scale, y: C.BASE_ARENA_HALF.y * scale };
		this.arena = {
			x: C.ARENA_CENTER.x - this.arenaHalf.x, y: C.ARENA_CENTER.y - this.arenaHalf.y,
			w: this.arenaHalf.x * 2, h: this.arenaHalf.y * 2,
		};
		this.obstacles = C.OBSTACLE_FRACTIONS.map((o) => {
			const cx = C.ARENA_CENTER.x + o.off.x * this.arenaHalf.x;
			const cy = C.ARENA_CENTER.y + o.off.y * this.arenaHalf.y;
			return { x: cx - o.size.x / 2, y: cy - o.size.y / 2, w: o.size.x, h: o.size.y };
		});
	}

	spawnPoints(n) {
		const pts = [];
		const halfX = this.arenaHalf.x;
		const halfY = this.arenaHalf.y;
		const cx = C.ARENA_CENTER.x;
		const cy = C.ARENA_CENTER.y;
		// Margen seguro respecto a las paredes exteriores
		const padX = Math.max(70, halfX * 0.16);
		const padY = Math.max(60, halfY * 0.16);

		// Slots de máxima separación (esquinas extremas opuestas y cuadrantes lejanos)
		const slots = [
			// 4 esquinas extremas (máxima distancia entre jugadores iniciales)
			{ x: cx - halfX + padX, y: cy - halfY + padY },
			{ x: cx + halfX - padX, y: cy + halfY - padY },
			{ x: cx + halfX - padX, y: cy - halfY + padY },
			{ x: cx - halfX + padX, y: cy + halfY - padY },
			// 4 posiciones periféricas intermedias opuestas
			{ x: cx, y: cy - halfY + padY },
			{ x: cx, y: cy + halfY - padY },
			{ x: cx - halfX + padX, y: cy },
			{ x: cx + halfX - padX, y: cy },
			// Cuadrantes semi-exteriores
			{ x: cx - halfX * 0.55, y: cy - halfY * 0.65 },
			{ x: cx + halfX * 0.55, y: cy + halfY * 0.65 },
			{ x: cx + halfX * 0.55, y: cy - halfY * 0.65 },
			{ x: cx - halfX * 0.55, y: cy + halfY * 0.65 },
		];

		// Asignar slots separados
		for (let i = 0; i < n; i++) {
			let pt;
			if (i < slots.length) {
				pt = { ...slots[i] };
			} else {
				// Distribuir en el perímetro externo con espaciado uniforme
				const angle = (Math.PI * 2 * (i - slots.length)) / (n - slots.length + 1) + 0.3;
				pt = {
					x: cx + Math.cos(angle) * (halfX - padX),
					y: cy + Math.sin(angle) * (halfY - padY),
				};
			}

			// Asegurar que no quede dentro de ningún muro
			const obstaclePad = 36;
			for (const o of this.obstacles) {
				if (pt.x >= o.x - obstaclePad && pt.x <= o.x + o.w + obstaclePad &&
					pt.y >= o.y - obstaclePad && pt.y <= o.y + o.h + obstaclePad) {
					// Correr hacia el borde exterior libre
					pt.x = pt.x < cx ? pt.x - 45 : pt.x + 45;
					pt.y = pt.y < cy ? pt.y - 45 : pt.y + 45;
				}
			}

			// Clamping dentro de la arena
			pt.x = Math.max(cx - halfX + 35, Math.min(cx + halfX - 35, pt.x));
			pt.y = Math.max(cy - halfY + 35, Math.min(cy + halfY - 35, pt.y));
			pts.push(pt);
		}
		return pts;
	}

	start() {
		if (this.started) return;
		this.started = true;
		this.computeArena();
		const ids = [...this.players.keys()];
		const pts = this.spawnPoints(ids.length);
		ids.forEach((id, i) => {
			const p = this.players.get(id);
			p.x = pts[i].x; p.y = pts[i].y;
			p.maxHp = C.PLAYER_STATS.health; p.hp = C.PLAYER_STATS.health; p.alive = true;
			p.bombCount = 0; p.shieldRemaining = 0;
			p.hitTargetThisRound = false; p.penalized = false;
			p.keys = { up: false, down: false, left: false, right: false };
			p.aim = { x: 1, y: 0 };
			p.bombCharging = false; p.bombChargeStart = 0;
			p.botShootCooldown = 0;
		});
		this.reshuffleGroups();
		broadcast(this, { t: "match_start" });
	}

	// Distribución de grupos y sorteo aleatorio de presa según la regla:
	// - Con menos de 4 jugadores (2 o 3), se usan solo 2 o 3 colores (uno por persona).
	// - Con N ≥ 4, se usan máximo 4 colores:
	//     base = Math.floor(N / 4)
	//     sobrante = N % 4
	//   Los 'sobrante' grupos reciben base + 1 integrantes, y el resto recibe base integrantes.
	//   (Ej: 8 → 4 de 2; 9 → 3 de 2 + 1 de 3; 16 → 4 de 4; 17 → 3 de 4 + 1 de 5; 19 → 1 de 4 + 3 de 5).
	// - La presa (color a eliminar) de cada grupo/jugador se sortea de forma 100% aleatoria entre los rivales activos.
	reshuffleGroups() {
		const alivePlayers = [...this.players.values()].filter((p) => p.alive);
		if (alivePlayers.length === 0) return;

		const N = alivePlayers.length;
		// Si entran menos de 4 (2 o 3 jugadores), se usan solo 2 o 3 colores (uno por persona)
		const numGroups = N < 4 ? Math.max(1, N) : 4;
		const base = Math.floor(N / numGroups);
		const sobrante = N % numGroups;

		// Calcular el tamaño de cada grupo
		const groupSizes = [];
		for (let i = 0; i < numGroups; i++) {
			groupSizes.push(i < sobrante ? base + 1 : base);
		}

		// Colores disponibles de los 4 oficiales (0: Rojo, 1: Azul, 2: Verde, 3: Amarillo)
		const activeColorIndices = [0, 1, 2, 3].slice(0, numGroups);

		// Mezclar jugadores y mezclar qué colores reciben el integrante extra del sobrante
		const shuffledAlive = shuffle([...alivePlayers]);
		const shuffledSizes = shuffle([...groupSizes]);

		let playerPointer = 0;
		const activeColorsInMatch = [];

		activeColorIndices.forEach((colorIdx, i) => {
			const size = shuffledSizes[i];
			const groupMembers = shuffledAlive.slice(playerPointer, playerPointer + size);
			playerPointer += size;

			if (groupMembers.length > 0) {
				activeColorsInMatch.push(colorIdx);
			}

			for (const p of groupMembers) {
				p.colorIdx = colorIdx;
				p.color = C.GROUP_COLORS[colorIdx].key;
				p.hitTargetThisRound = false;
			}
		});

		// Sorteo aleatorio e INDIVIDUAL de la presa (color a eliminar) para cada
		// jugador. Ya no es una cadena por grupo (todo azul caza rojo, todo rojo
		// caza amarillo, etc.): cada jugador tira su propio dado entre los otros
		// colores en juego, así que dos jugadores del mismo color de cuerpo
		// pueden terminar cazando presas distintas (un azul caza verdes, otro
		// amarillos, otro rojos...), y lo mismo aplica por igual a los 4 grupos.
		// Si solo hay 1 color en juego (p.ej. un solo jugador en la sala), se
		// elige cualquier otro de los 4 colores oficiales.
		shuffledAlive.forEach((p) => {
			let enemyCandidates = activeColorsInMatch.filter((c) => c !== p.colorIdx);
			if (enemyCandidates.length === 0) {
				enemyCandidates = [0, 1, 2, 3].filter((c) => c !== p.colorIdx);
			}
			const targetIdx = enemyCandidates[Math.floor(Math.random() * enemyCandidates.length)];
			p.targetColorIdx = targetIdx;
			p.targetColor = C.GROUP_COLORS[targetIdx].key;
		});

		this.roundTimer = C.ROUND_DURATION;
		this.roundWarned = false;
		this.roundNumber++;
		broadcast(this, { t: "round_start", round: this.roundNumber });
	}

	toast(text, color) { broadcast(this, { t: "toast", text, color }); }

	applyDamage(victimId, dmg, attackerId, viaBomb) {
		const v = this.players.get(victimId);
		if (!v || !v.alive) return;
		if (v.shieldRemaining > 0) {
			this.toast(`🛡 ${v.name} bloqueó el daño con su burbuja`, "#6fe3ff");
			return;
		}
		let finalDmg = Math.max(1, Math.round(dmg * (1 - C.PLAYER_STATS.defense)));
		v.hp = Math.max(0, v.hp - finalDmg);
		if (!v.damagedBy) v.damagedBy = new Set();
		if (attackerId > 0) v.damagedBy.add(attackerId);

		const died = v.hp <= 0;
		if (died) {
			v.alive = false;
			this.eliminationOrder.push(victimId);

			// Reconocer la eliminación del objetivo para el atacante y aliados que colaboraron
			for (const pid of v.damagedBy) {
				const helper = this.players.get(pid);
				if (helper && helper.alive && helper.targetColorIdx === v.colorIdx) {
					helper.eliminatedTargetThisRound = true;
				}
			}
		}
		const attacker = attackerId > 0 ? this.players.get(attackerId) : null;
		if (attacker) attacker.hitTargetThisRound = true;
		if (!v.alive) {
			this.toast(`💀 ${v.name} fue eliminado`, "#ff7a7a");
		} else if (attackerId === -1) {
			this.toast(`⚠ ${v.name} perdió 1 porción de vida (-${finalDmg} HP)`, "#ff9d3c");
		} else if (viaBomb) {
			this.toast(`💥 ${attacker ? attacker.name : "?"} voló a su objetivo con una bomba: ${v.name}  (-${finalDmg} HP)`, "#ffb15e");
		} else {
			this.toast(`${attacker ? attacker.name : "?"} impactó a su objetivo: ${v.name}  (-${finalDmg} HP)`, "#ffffff");
		}
		this.checkWin();
		this.checkAllTargetsEliminated();
		this.checkOrphanedTargets();
	}

	checkWin() {
		if (this.matchOver) return;
		if (this.players.size < 2) return;
		const aliveIds = [...this.players.values()].filter((p) => p.alive).map((p) => p.id);
		if (aliveIds.length <= 1) {
			this.matchOver = true;
			this.winnerId = aliveIds.length === 1 ? aliveIds[0] : -1;
			const standings = [];
			if (this.winnerId !== -1) standings.push(this.winnerId);
			const rev = [...this.eliminationOrder].reverse();
			for (const pid of rev) if (pid !== this.winnerId) standings.push(pid);
			const rows = standings.map((pid) => {
				const p = this.players.get(pid);
				return { name: p ? p.name : "?", color: p ? p.color : "red" };
			});
			broadcast(this, { t: "match_over", winnerName: this.winnerId !== -1 ? this.players.get(this.winnerId).name : null, standings: rows });
		} else if (aliveIds.length <= 4) {
			// Convergencia al 1 vs 1
			const colorsInUse = new Set(aliveIds.map((id) => this.players.get(id).colorIdx));
			if (colorsInUse.size !== aliveIds.length) this.reshuffleGroups();
		}
	}

	spawnRandomPowerup() {
		const types = ["shield", "bomb", "health"];
		const type = types[Math.floor(Math.random() * types.length)];
		const margin = 50;
		const clearance = 34;
		let pos = null;
		for (let attempt = 0; attempt < 25; attempt++) {
			const candidate = {
				x: this.arena.x + margin + Math.random() * Math.max(1, this.arena.w - margin * 2),
				y: this.arena.y + margin + Math.random() * Math.max(1, this.arena.h - margin * 2),
			};
			const blocked = this.obstacles.some((o) => {
				const cx = Math.max(o.x, Math.min(candidate.x, o.x + o.w));
				const cy = Math.max(o.y, Math.min(candidate.y, o.y + o.h));
				return Math.hypot(candidate.x - cx, candidate.y - cy) < clearance;
			});
			if (!blocked) { pos = candidate; break; }
		}
		if (!pos) return;
		const id = this.nextEntityId++;
		this.powerups.push({ id, type, x: pos.x, y: pos.y, life: C.POWERUP_LIFETIME });
	}

	applyPowerup(pid, type) {
		const p = this.players.get(pid);
		if (!p) return;
		if (type === "health") {
			p.hp = Math.min(p.maxHp, p.hp + C.HEAL_AMOUNT);
			this.toast(`💚 ${p.name} usó un botiquín`, "#7dffb0");
		} else if (type === "shield") {
			p.shieldRemaining = C.SHIELD_DURATION;
			this.toast(`🛡 ${p.name} activó una burbuja protectora`, "#6fe3ff");
		} else if (type === "bomb") {
			p.bombCount = Math.min(C.BOMB_MAX, p.bombCount + 1);
			this.toast(`💣 ${p.name} recogió una bomba`, "#ffb15e");
		}
	}

	explodeBomb(center, shooterId, targetColorIdx) {
		for (const p of this.players.values()) {
			if (p.id === shooterId || !p.alive) continue;
			if (p.colorIdx !== targetColorIdx) continue;
			const dist = Math.hypot(p.x - center.x, p.y - center.y);
			if (dist <= C.BOMB_RADIUS) this.applyDamage(p.id, C.BOMB_DAMAGE, shooterId, true);
		}
	}

	releaseBombFor(p) {
		if (!p || !p.bombCharging) return;
		p.bombCharging = false;
		if (!p.alive || !this.started || this.matchOver || p.bombCount <= 0) return;
		p.bombCount--;
		const heldSec = Math.min(C.BOMB_MAX_CHARGE_TIME, (Date.now() - p.bombChargeStart) / 1000);
		const frac = heldSec / C.BOMB_MAX_CHARGE_TIME;
		const range = C.BOMB_RANGE_MIN + (C.BOMB_RANGE_MAX - C.BOMB_RANGE_MIN) * frac;
		const len = Math.hypot(p.aim.x, p.aim.y) || 1;
		const tx = p.x + (p.aim.x / len) * range;
		const ty = p.y + (p.aim.y / len) * range;
		this.bombs.push({ fx: p.x, fy: p.y, tx, ty, x: p.x, y: p.y, t: 0, owner: p.id, exploded: false, explodeT: 0, targetColorIdx: p.targetColorIdx });
	}

	tick(dt) {
		if (!this.started) return;
		if (!this.matchOver) {
			this.updateRound(dt);
			this.updateBots(dt);
			this.updatePlayers(dt);
			this.updateBullets(dt);
			this.updateBombs(dt);
			this.updatePowerups(dt);
			for (const p of this.players.values()) {
				if (p.bombCharging && (Date.now() - p.bombChargeStart) > C.BOMB_MAX_CHARGE_TIME * 1000) {
					this.releaseBombFor(p);
				}
			}
		}
		for (const p of this.players.values()) {
			if (p.shieldRemaining > 0) p.shieldRemaining = Math.max(0, p.shieldRemaining - dt);
		}
		this.broadcastState();
	}

	updateBots(dt) {
		for (const p of this.players.values()) {
			if (!p.isBot || !p.alive) continue;
			p.botShootCooldown = Math.max(0, (p.botShootCooldown || 0) - dt);

			// Buscar objetivo con su color designado
			let target = null;
			let minDist = 999999;
			for (const other of this.players.values()) {
				if (!other.alive || other.id === p.id) continue;
				if (other.colorIdx === p.targetColorIdx) {
					const dist = Math.hypot(other.x - p.x, other.y - p.y);
					if (dist < minDist) { minDist = dist; target = other; }
				}
			}

			if (target) {
				const dx = target.x - p.x;
				const dy = target.y - p.y;
				const len = Math.hypot(dx, dy) || 1;
				p.aim = { x: dx / len, y: dy / len };
				p.keys = {
					right: dx > 25,
					left: dx < -25,
					down: dy > 25,
					up: dy < -25,
				};

				// Disparar cuando esté a distancia
				if (minDist < 420 && p.botShootCooldown <= 0) {
					p.botShootCooldown = 0.5 + Math.random() * 0.4;
					this.bullets.push({
						id: this.nextEntityId++, x: p.x, y: p.y,
						dx: p.aim.x, dy: p.aim.y,
						owner: p.id, damage: C.PLAYER_STATS.damage, life: C.BULLET_LIFE,
						targetColorIdx: p.targetColorIdx,
					});
				}
			} else {
				// Deambular
				if (Math.random() < 0.05) {
					p.keys = {
						right: Math.random() > 0.5,
						left: Math.random() > 0.5,
						down: Math.random() > 0.5,
						up: Math.random() > 0.5,
					};
				}
			}
		}
	}

	updateRound(dt) {
		this.roundTimer -= dt;
		if (this.roundTimer <= C.ROUND_WARNING_TIME && !this.roundWarned) {
			this.roundWarned = true;
			this.toast("⏱ 15 SEGUNDOS — ¡Elimina a tu presa para no perder 1 porción de vida!", "#ffd34e");
		}
		if (this.roundTimer <= 0) {
			this.endRound(false);
		}
	}

	// Revisa si todos los jugadores vivos ya eliminaron a su objetivo antes
	// de que se agoten los 2 minutos. Si es así, la ronda termina de inmediato
	// y se pasa a la siguiente sin esperar al cronómetro.
	checkAllTargetsEliminated() {
		if (this.matchOver) return;
		const alivePlayers = [...this.players.values()].filter((p) => p.alive);
		if (alivePlayers.length < 2) return;
		const allDone = alivePlayers.every((p) => p.eliminatedTargetThisRound);
		if (allDone) this.endRound(true);
	}

	// Revisa si algún jugador se quedó "sin objetivo posible": todos los
	// integrantes vivos del color que debía cazar ya murieron (por ejemplo,
	// otro jugador se los llevó por delante). Si eso pasa antes de que se
	// agote el cronómetro de la ronda (ROUND_DURATION), no tiene sentido
	// hacerlo esperar sin poder cumplir su objetivo: se le reasigna al
	// instante un nuevo color de cuerpo junto con un nuevo color a eliminar.
	checkOrphanedTargets() {
		if (this.matchOver) return;
		const alivePlayers = [...this.players.values()].filter((p) => p.alive);
		if (alivePlayers.length < 2) return;
		for (const p of alivePlayers) {
			if (p.eliminatedTargetThisRound) continue; // ya cumplió, no necesita reasignación
			const targetStillAlive = alivePlayers.some((o) => o.id !== p.id && o.colorIdx === p.targetColorIdx);
			if (!targetStillAlive) this.reassignOrphanedPlayer(p);
		}
	}

	// Le da a un jugador huérfano de objetivo un nuevo color de cuerpo y un
	// nuevo color a eliminar, sorteados entre los colores que sigan en juego.
	reassignOrphanedPlayer(p) {
		const alivePlayers = [...this.players.values()].filter((q) => q.alive);
		const colorsInPlay = [...new Set(alivePlayers.filter((q) => q.id !== p.id).map((q) => q.colorIdx))];

		// Nuevo color de cuerpo: distinto al actual si hay otra opción disponible.
		let colorCandidates = colorsInPlay.length > 0 ? colorsInPlay : [0, 1, 2, 3].filter((c) => c !== p.colorIdx);
		colorCandidates = colorCandidates.filter((c) => c !== p.colorIdx);
		const newColorIdx = colorCandidates.length > 0
			? colorCandidates[Math.floor(Math.random() * colorCandidates.length)]
			: p.colorIdx;

		// Nuevo objetivo: cualquier color en juego (con jugadores vivos) distinto
		// del nuevo color propio; si no queda ninguno, cualquiera de los 4 oficiales.
		let targetCandidates = colorsInPlay.filter((c) => c !== newColorIdx);
		if (targetCandidates.length === 0) {
			targetCandidates = [0, 1, 2, 3].filter((c) => c !== newColorIdx);
		}
		const newTargetIdx = targetCandidates[Math.floor(Math.random() * targetCandidates.length)];

		p.colorIdx = newColorIdx;
		p.color = C.GROUP_COLORS[newColorIdx].key;
		p.targetColorIdx = newTargetIdx;
		p.targetColor = C.GROUP_COLORS[newTargetIdx].key;
		p.eliminatedTargetThisRound = false;

		this.toast(
			`🔄 ${p.name} se quedó sin presa (ya no quedan) — ahora es ${C.GROUP_COLORS[newColorIdx].name} y debe cazar ${C.GROUP_COLORS[newTargetIdx].name}`,
			"#ffd23f"
		);
	}

	// Cierra la ronda actual (por cronómetro agotado o por cumplimiento anticipado
	// de todos los objetivos dentro del cuadrilátero) y prepara la siguiente.
	endRound(early) {
		if (this.matchOver) return;
		if (early) {
			this.toast("🎯 ¡Todos eliminaron a su objetivo! Comienza la siguiente ronda", "#3ddc84");
		}
		// Si no llegaron a eliminar ni un objetivo se le drena una porción de su vida (34 HP)
		// En la 3ra ronda consecutiva sin matar a nadie se auto-elimina (100 - 34*3 <= 0)
		const portionDamage = Math.ceil(C.PLAYER_STATS.health / 3); // 34 HP
		for (const p of this.players.values()) {
			if (!p.alive) continue;
			if (!p.eliminatedTargetThisRound) {
				p.hp = Math.max(0, p.hp - portionDamage);
				if (p.hp <= 0) {
					p.alive = false;
					this.eliminationOrder.push(p.id);
					this.toast(`💀 ${p.name} no eliminó a su presa en 3 rondas y se auto-eliminó`, "#ff5a6e");
				} else {
					this.toast(`⚠ ${p.name} no eliminó a su presa: -${portionDamage} HP (1 porción)`, "#ff9d3c");
				}
			} else {
				this.toast(`🛡 ${p.name} cumplió su objetivo y conservó su vida`, "#3ddc84");
			}
		}

		this.checkWin();

		if (!this.matchOver) {
			// Reiniciar registros de eliminación para la nueva ronda
			for (const p of this.players.values()) {
				p.eliminatedTargetThisRound = false;
				p.hitTargetThisRound = false;
				p.damagedBy = new Set();
			}
			// Al terminar la ronda (por tiempo o de forma anticipada) también se
			// vuelve a repartir colores y objetivos.
			this.reshuffleGroups();
		}
	}

	updatePlayers(dt) {
		for (const p of this.players.values()) {
			if (!p.alive) continue;
			let dx = (p.keys.right ? 1 : 0) - (p.keys.left ? 1 : 0);
			let dy = (p.keys.down ? 1 : 0) - (p.keys.up ? 1 : 0);
			const len = Math.hypot(dx, dy);
			if (len > 0) { dx /= len; dy /= len; }
			let nx = p.x + dx * C.PLAYER_STATS.speed * dt;
			let ny = p.y + dy * C.PLAYER_STATS.speed * dt;
			for (const o of this.obstacles) {
				const cx = Math.max(o.x, Math.min(nx, o.x + o.w));
				const cy = Math.max(o.y, Math.min(ny, o.y + o.h));
				const distX = nx - cx, distY = ny - cy;
				const dist = Math.hypot(distX, distY);
				if (dist < C.PLAYER_RADIUS && dist > 0.001) {
					const push = (C.PLAYER_RADIUS - dist);
					nx += (distX / dist) * push;
					ny += (distY / dist) * push;
				}
			}
			nx = Math.min(Math.max(nx, this.arena.x + 15), this.arena.x + this.arena.w - 15);
			ny = Math.min(Math.max(ny, this.arena.y + 15), this.arena.y + this.arena.h - 15);
			p.x = nx;
			p.y = ny;
		}
	}

	updateBullets(dt) {
		this.bullets = this.bullets.filter((b) => {
			b.x += b.dx * C.BULLET_SPEED * dt;
			b.y += b.dy * C.BULLET_SPEED * dt;
			b.life -= dt;
			if (b.life <= 0) return false;
			for (const o of this.obstacles) {
				if (b.x >= o.x && b.x <= o.x + o.w && b.y >= o.y && b.y <= o.y + o.h) return false;
			}
			for (const p of this.players.values()) {
				if (p.id === b.owner || !p.alive) continue;
				if (p.colorIdx !== b.targetColorIdx) continue;
				if (Math.hypot(p.x - b.x, p.y - b.y) < 20) {
					this.applyDamage(p.id, b.damage, b.owner);
					return false;
				}
			}
			return true;
		});
	}

	updateBombs(dt) {
		this.bombs = this.bombs.filter((bm) => {
			if (bm.exploded) { bm.explodeT += dt; return bm.explodeT < 0.4; }
			bm.t += dt / 0.35;
			if (bm.t >= 1) {
				bm.t = 1; bm.exploded = true; bm.explodeT = 0;
				bm.x = bm.tx; bm.y = bm.ty;
				this.explodeBomb({ x: bm.tx, y: bm.ty }, bm.owner, bm.targetColorIdx);
			} else {
				bm.x = bm.fx + (bm.tx - bm.fx) * bm.t;
				bm.y = bm.fy + (bm.ty - bm.fy) * bm.t - Math.sin(bm.t * Math.PI) * 26;
			}
			return true;
		});
	}

	updatePowerups(dt) {
		this.powerupSpawnTimer -= dt;
		if (this.powerupSpawnTimer <= 0) {
			this.powerupSpawnTimer = C.POWERUP_SPAWN_MIN + Math.random() * (C.POWERUP_SPAWN_MAX - C.POWERUP_SPAWN_MIN);
			if (this.powerups.length < C.POWERUP_MAX_ACTIVE) this.spawnRandomPowerup();
		}
		this.powerups = this.powerups.filter((pu) => {
			pu.life -= dt;
			if (pu.life <= 0) return false;
			for (const p of this.players.values()) {
				if (!p.alive) continue;
				if (Math.hypot(p.x - pu.x, p.y - pu.y) < 26) { this.applyPowerup(p.id, pu.type); return false; }
			}
			return true;
		});
	}

	broadcastState() {
		const base = {
			t: "state",
			arena: this.arena,
			obstacles: this.obstacles,
			players: [...this.players.values()].map((p) => ({
				id: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp,
				alive: p.alive, color: p.color, bombCount: p.bombCount,
				shieldRemaining: p.shieldRemaining, penalized: p.penalized, aim: p.aim,
				bombCharging: p.bombCharging,
				bombChargeFrac: p.bombCharging ? Math.min(1, (Date.now() - p.bombChargeStart) / (C.BOMB_MAX_CHARGE_TIME * 1000)) : 0,
			})),
			bullets: this.bullets.map((b) => ({ x: b.x, y: b.y })),
			bombs: this.bombs.map((b) => ({ x: b.x, y: b.y, exploded: b.exploded, explodeT: b.explodeT || 0 })),
			powerups: this.powerups.map((pu) => ({ id: pu.id, type: pu.type, x: pu.x, y: pu.y, life: pu.life })),
			roundTimer: Math.max(0, this.roundTimer),
			matchOver: this.matchOver,
		};
		for (const p of this.players.values()) {
			if (!p.ws || p.ws.readyState !== p.ws.OPEN) continue;
			base.myTarget = p.targetColor || null;
			base.myTargetEliminated = !!p.eliminatedTargetThisRound;
			base.myPenalized = !p.eliminatedTargetThisRound && this.roundTimer <= 25;
			p.ws.send(JSON.stringify(base));
		}
	}
}

// ---------------------------------------------------------------- WS

wss.on("connection", (ws) => {
	let room = null;
	let playerId = null;

	ws.on("message", (raw) => {
		let msg;
		try { msg = JSON.parse(raw); } catch (e) { return; }

		if (msg.t === "join") {
			const name = String(msg.name || "Jugador").slice(0, 18) || "Jugador";
			let code = (msg.code || "").toUpperCase().trim();

			if (code) {
				room = rooms.get(code);
				if (!room) { send(ws, { t: "error", message: "Ese código de sala no existe." }); return; }
				if (room.started) { send(ws, { t: "error", message: "Esa partida ya comenzó." }); return; }
				if (room.players.size >= C.ROOM_MAX_PLAYERS) { send(ws, { t: "error", message: "La sala está llena." }); return; }
			} else {
				code = genRoomCode();
				room = new Room(code);
				rooms.set(code, room);
			}

			playerId = nextGlobalId++;
			const isHost = room.players.size === 0;
			room.players.set(playerId, {
				id: playerId, ws, name,
				x: 0, y: 0, hp: 0, maxHp: 0, alive: false,
				color: "red", colorIdx: 0, targetColor: "blue", targetColorIdx: 1,
				bombCount: 0, shieldRemaining: 0, hitTargetThisRound: false, penalized: false,
				keys: { up: false, down: false, left: false, right: false }, aim: { x: 1, y: 0 },
			});
			if (isHost) room.hostId = playerId;

			send(ws, { t: "joined", code, playerId, isHost, players: room.lobbyList() });
			broadcast(room, { t: "lobby_update", players: room.lobbyList() });
			return;
		}

		if (!room || playerId === null) return;
		const p = room.players.get(playerId);

		switch (msg.t) {
			case "start":
				if (playerId === room.hostId && !room.started) room.start();
				break;
			case "add_bot": {
				if (playerId !== room.hostId || room.started) break;
				if (room.players.size >= C.ROOM_MAX_PLAYERS) break;
				const botId = nextGlobalId++;
				const botNames = ["Bot Sombra", "Bot Rayo", "Bot Destello", "Bot Fénix", "Bot Cazador", "Bot Centinela", "Bot Titán", "Bot Ciber"];
				const chosenName = botNames[Math.floor(Math.random() * botNames.length)] + " #" + (botId % 100);
				room.players.set(botId, {
					id: botId,
					ws: null,
					name: chosenName,
					isBot: true,
					x: 0, y: 0, hp: 0, maxHp: 0, alive: false,
					color: "red", colorIdx: 0, targetColor: "blue", targetColorIdx: 1,
					bombCount: 0, shieldRemaining: 0, hitTargetThisRound: false, penalized: false,
					keys: { up: false, down: false, left: false, right: false }, aim: { x: 1, y: 0 },
					botShootCooldown: 0,
				});
				broadcast(room, { t: "lobby_update", players: room.lobbyList() });
				break;
			}
			case "remove_bot": {
				if (playerId !== room.hostId || room.started) break;
				// Remover el último bot agregado
				let targetBotId = null;
				for (const [id, pl] of [...room.players.entries()].reverse()) {
					if (pl.isBot) { targetBotId = id; break; }
				}
				if (targetBotId) {
					room.players.delete(targetBotId);
					broadcast(room, { t: "lobby_update", players: room.lobbyList() });
				}
				break;
			}
			case "input":
				if (p && msg.keys) {
					p.keys = { up: !!msg.keys.up, down: !!msg.keys.down, left: !!msg.keys.left, right: !!msg.keys.right };
				}
				if (p && msg.aim) p.aim = { x: Number(msg.aim.x) || 0, y: Number(msg.aim.y) || 0 };
				break;
			case "shoot": {
				if (!p || !p.alive || !room.started || room.matchOver) break;
				const len = Math.hypot(p.aim.x, p.aim.y) || 1;
				room.bullets.push({
					id: room.nextEntityId++, x: p.x, y: p.y,
					dx: p.aim.x / len, dy: p.aim.y / len,
					owner: playerId, damage: C.PLAYER_STATS.damage, life: C.BULLET_LIFE,
					targetColorIdx: p.targetColorIdx,
				});
				break;
			}
			case "bomb_start":
				if (!p || !p.alive || !room.started || room.matchOver) break;
				if (p.bombCount <= 0) break;
				p.bombCharging = true;
				p.bombChargeStart = Date.now();
				break;
			case "bomb_release":
				room.releaseBombFor(p);
				break;
			case "chat": {
				if (!p) break;
				const text = String(msg.text || "").slice(0, 120).trim();
				if (!text) break;
				broadcast(room, { t: "chat", name: p.name, text });
				break;
			}
			default: break;
		}
	});

	ws.on("close", () => {
		if (!room || playerId === null) return;
		room.players.delete(playerId);
		if (room.players.size === 0) { rooms.delete(room.code); return; }
		if (room.hostId === playerId) {
			// Asignar anfitrión a un jugador humano si existe
			const humanId = [...room.players.values()].find((p) => !p.isBot)?.id || [...room.players.keys()][0];
			room.hostId = humanId;
		}
		if (!room.started) broadcast(room, { t: "lobby_update", players: room.lobbyList() });
		else room.checkWin();
	});
});

setInterval(() => {
	const dt = TICK_MS / 1000;
	for (const room of rooms.values()) room.tick(dt);
}, TICK_MS);

server.listen(PORT, () => console.log(`Caza de Colores escuchando en puerto ${PORT}`));
