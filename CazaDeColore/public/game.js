// game.js — Cliente de Caza de Colores con Lobby Modernizado y Juego en Tiempo Real

(() => {
	const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

	let ws = null;
	let myId = null;
	let isHost = false;

	let state = null;
	let matchStarted = false;
	let matchOver = false;

	const keys = { up: false, down: false, left: false, right: false };
	let mouseWorld = { x: 0, y: 0 };
	let cameraZoom = 1.4;

	const el = (id) => document.getElementById(id);

	function colorHex(key) {
		const c = GROUP_COLORS.find((g) => g.key === key);
		return c ? c.hex : "#cccccc";
	}
	function colorName(key) {
		const c = GROUP_COLORS.find((g) => g.key === key);
		return c ? c.name : "—";
	}

	// ---------------------------------------------------------------- LOBBY TABS & PREVIEW
	const tabButtons = document.querySelectorAll(".tab-btn");
	tabButtons.forEach((btn) => {
		btn.addEventListener("click", () => {
			Sound.click();
			tabButtons.forEach((b) => b.classList.remove("active"));
			btn.classList.add("active");
			const targetId = btn.getAttribute("data-tab");
			document.querySelectorAll(".tab-content").forEach((panel) => {
				if (panel.id !== "waiting-panel") panel.classList.add("hidden");
			});
			const target = el(targetId);
			if (target && el("waiting-panel").classList.contains("hidden")) {
				target.classList.remove("hidden");
				target.classList.add("active");
			}
		});
	});

	// Vista previa del Guardián: paradito de frente, sin rotar
	const COMBAT_COLORS = ["red", "blue", "green", "yellow"];
	let previewColorIdx = 0;
	let previewColor = COMBAT_COLORS[0];
	let lastColorSwitch = performance.now();
	const previewCanvas = el("preview-canvas");
	const previewCtx = previewCanvas.getContext("2d");
	// Con ángulo -Math.PI / 2, la rotación resultante (angle + PI/2) es 0, quedando de pie mirando al frente
	const STANDING_ANGLE = -Math.PI / 2;

	(function previewLoop(time) {
		requestAnimationFrame(previewLoop);
		const now = time || performance.now();
		if (now - lastColorSwitch > 2600) {
			previewColorIdx = (previewColorIdx + 1) % COMBAT_COLORS.length;
			previewColor = COMBAT_COLORS[previewColorIdx];
			lastColorSwitch = now;
		}
		// Sutil respiración vertical para que se vea vivo mientras está paradito
		previewCtx.clearRect(0, 0, 240, 240);
		drawGuardian(previewCtx, 120, 122, null, previewColor, 3.75, { idlePhase: now / 400 });
	})();

	// Name input persistence
	const nameInput = el("name-input");
	const savedName = sessionStorage.getItem("zc_name");
	if (savedName) nameInput.value = savedName;
	nameInput.addEventListener("input", () => sessionStorage.setItem("zc_name", nameInput.value));

	el("code-input").addEventListener("keydown", (e) => {
		if (e.key === "Enter") el("btn-join").click();
	});

	// Sound settings in lobby
	const volSlider = el("volume-slider");
	const volVal = el("volume-val");
	volSlider.addEventListener("input", (e) => {
		const val = Number(e.target.value);
		volVal.textContent = `${val}%`;
		Sound.setVolume(val / 100);
	});

	const muteToggle = el("mute-toggle");
	muteToggle.addEventListener("change", (e) => {
		Sound.setMuted(e.target.checked);
		if (window.updateLobbyMusicUI) window.updateLobbyMusicUI();
	});

	// Lobby Chill Music Controls
	const toggleMusicBtn = el("btn-toggle-lobby-music");
	const lobbyMusicToggle = el("lobby-music-toggle");
	const musicStateTag = el("music-state-tag");

	window.updateLobbyMusicUI = function(playing) {
		const isPlaying = typeof playing === "boolean" ? playing : Sound.isLobbyMusicPlaying();
		if (toggleMusicBtn) {
			toggleMusicBtn.classList.toggle("paused", !isPlaying);
		}
		if (musicStateTag) {
			musicStateTag.textContent = isPlaying ? "Sonando" : "En Pausa";
		}
		if (lobbyMusicToggle) {
			lobbyMusicToggle.checked = Sound.isLobbyMusicEnabled() && !Sound.isMuted();
		}
	};

	if (toggleMusicBtn) {
		toggleMusicBtn.addEventListener("click", () => {
			Sound.unlock();
			Sound.toggleLobbyMusic();
			window.updateLobbyMusicUI();
		});
	}

	if (lobbyMusicToggle) {
		lobbyMusicToggle.addEventListener("change", (e) => {
			Sound.unlock();
			if (e.target.checked) {
				Sound.startLobbyMusic();
			} else {
				Sound.stopLobbyMusic();
			}
			window.updateLobbyMusicUI();
		});
	}

	// Auto-iniciar la música chill de espera en el primer clic, toque o pulsación de tecla
	function initLobbyMusicOnGesture() {
		if (matchStarted) return;
		Sound.unlock();
		Sound.startLobbyMusic();
		window.updateLobbyMusicUI(true);
		window.removeEventListener("pointerdown", initLobbyMusicOnGesture);
		window.removeEventListener("keydown", initLobbyMusicOnGesture);
	}
	window.addEventListener("pointerdown", initLobbyMusicOnGesture, { once: true });
	window.addEventListener("keydown", initLobbyMusicOnGesture, { once: true });

	// Intento de reproducir la música apenas carga la página, sin esperar
	// ningún clic. Los navegadores modernos bloquean el audio hasta el primer
	// gesto del usuario, así que esto suena de inmediato quien lo permita, y
	// para el resto queda el listener de arriba, que la activa en el primer
	// toque/tecla/clic (lo más "automático" que el navegador permite).
	(function tryImmediateAutoplay() {
		Sound.unlock();
		Sound.startLobbyMusic();
		window.updateLobbyMusicUI(true);
		// Reintentar en cuanto la pestaña quede visible/enfocada, por si el
		// AudioContext se creó "suspended" al cargar en segundo plano.
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible" && !matchStarted) {
				Sound.unlock();
				Sound.startLobbyMusic();
				window.updateLobbyMusicUI(true);
			}
		});
	})();

	el("btn-test-sound").onclick = () => {
		Sound.unlock();
		Sound.powerup();
		setTimeout(() => Sound.shoot(), 200);
	};

	// ---------------------------------------------------------------- LOBBY UI & NETWORKING
	function menuStatus(msg) { el("menu-status").textContent = msg || ""; }

	function connectAndJoin(code) {
		Sound.unlock();
		Sound.click();
		const name = el("name-input").value.trim() || "Jugador";
		menuStatus(code ? "Conectando a la sala..." : "Creando nueva sala...");
		ws = new WebSocket(WS_URL);
		ws.onopen = () => ws.send(JSON.stringify({ t: "join", name, code: code || "" }));
		ws.onmessage = onMessage;
		ws.onclose = () => { if (!matchStarted) menuStatus("Se perdió la conexión con el servidor."); };
		ws.onerror = () => menuStatus("No se pudo conectar al servidor.");
	}

	el("btn-create").onclick = () => connectAndJoin("");
	el("btn-join").onclick = () => {
		const code = el("code-input").value.trim();
		if (!code) { menuStatus("Por favor ingresa un código de sala."); return; }
		connectAndJoin(code);
	};
	el("btn-leave-lobby").onclick = () => location.reload();
	el("btn-leave-game").onclick = () => location.reload();
	el("btn-ranking-leave").onclick = () => location.reload();
	el("btn-start").onclick = () => {
		Sound.click();
		if (ws) ws.send(JSON.stringify({ t: "start" }));
	};

	// Bot actions for host
	el("btn-add-bot").onclick = () => {
		Sound.click();
		if (ws && isHost) ws.send(JSON.stringify({ t: "add_bot" }));
	};
	el("btn-remove-bot").onclick = () => {
		Sound.click();
		if (ws && isHost) ws.send(JSON.stringify({ t: "remove_bot" }));
	};

	// Copy room code
	el("btn-copy-code").onclick = () => {
		Sound.click();
		const code = el("room-code-display").textContent.trim();
		if (!code || code === "——") return;
		navigator.clipboard.writeText(code).then(() => {
			const fb = el("copy-feedback");
			fb.classList.remove("hidden");
			setTimeout(() => fb.classList.add("hidden"), 2000);
		}).catch(() => {
			prompt("Copia el código de tu sala:", code);
		});
	};

	function onMessage(ev) {
		const msg = JSON.parse(ev.data);
		switch (msg.t) {
			case "joined":
				myId = msg.playerId; isHost = msg.isHost;
				el("room-code-display").textContent = msg.code;
				showWaiting(msg.players);
				break;
			case "error": menuStatus(msg.message); break;
			case "lobby_update": showWaiting(msg.players); break;
			case "match_start": matchStarted = true; startGameScreen(); break;
			case "round_start":
				if (msg.round > 1) showToast("🎲 ¡Nuevos colores y presas asignados!", "#c9a6ff");
				break;
			case "state": state = msg; break;
			case "toast": showToast(msg.text, msg.color); break;
			case "chat": addChatLine(msg.name, msg.text); break;
			case "match_over": matchOver = true; showRanking(msg); break;
		}
	}

	function showWaiting(players) {
		el("menu-panel").classList.add("hidden");
		el("rules-panel").classList.add("hidden");
		el("settings-panel").classList.add("hidden");
		el("waiting-panel").classList.remove("hidden");
		el("waiting-panel").classList.add("active");

		el("player-count-num").textContent = players.length;
		const hostPlayer = players.find((p) => p.isHost);
		el("host-name-val").textContent = hostPlayer ? hostPlayer.name : "—";

		const list = el("players-list");
		list.innerHTML = "";

		for (const p of players) {
			const card = document.createElement("div");
			card.className = "player-chip";

			const avatar = document.createElement("div");
			avatar.className = "player-chip-avatar" + (p.isBot ? " is-bot" : "");

			const name = document.createElement("div");
			name.className = "player-chip-name";
			name.textContent = p.name + (p.id === myId ? " (Tú)" : "");

			card.appendChild(avatar);
			card.appendChild(name);

			if (p.isHost) {
				const tag = document.createElement("span");
				tag.className = "player-tag host";
				tag.textContent = "👑 HOST";
				card.appendChild(tag);
			} else if (p.isBot) {
				const tag = document.createElement("span");
				tag.className = "player-tag bot";
				tag.textContent = "🤖 BOT";
				card.appendChild(tag);
			}
			list.appendChild(card);
		}

		el("btn-start").classList.toggle("hidden", !isHost);
		el("host-bot-actions").classList.toggle("hidden", !isHost);

		el("waiting-hint").textContent = isHost
			? "Los colores se reparten al iniciar. Puedes agregar bots para probar o jugar de inmediato."
			: "Esperando a que el anfitrión inicie la partida...";
	}

	// ---------------------------------------------------------------- GAME SCREEN
	const canvas = el("canvas");
	const ctx = canvas.getContext("2d");
	const minimap = el("minimap");
	const mctx = minimap.getContext("2d");

	function resizeCanvas() {
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
		minimap.width = minimap.clientWidth;
		minimap.height = minimap.clientHeight;
	}
	window.addEventListener("resize", resizeCanvas);

	function startGameScreen() {
		el("lobby").classList.add("hidden");
		el("game-screen").classList.remove("hidden");
		resizeCanvas();
		Sound.startMusic();
		requestAnimationFrame(loop);
		setInterval(sendInput, 50);
	}

	// -------- input
	let bombKeyDown = false;
	window.addEventListener("keydown", (e) => {
		if (document.activeElement === el("chat-input")) {
			if (e.key === "Escape") {
				el("chat-input").blur();
				e.preventDefault();
			}
			return;
		}

		// Tecla para salir: ESCAPE (en cualquier pantalla) o X (durante la partida)
		if (e.key === "Escape") {
			e.preventDefault();
			handleEscape();
			return;
		}
		if (e.code === "KeyX" && matchStarted && !matchOver) {
			e.preventDefault();
			leaveGamePrompt();
			return;
		}

		// Tecla para aparecer y ocultar el chat: C o TAB
		if (e.code === "KeyC" || e.code === "Tab") {
			e.preventDefault();
			toggleChat();
			return;
		}

		if (e.key === "Enter") {
			if (chatHidden && chatWrap) {
				chatHidden = false;
				chatWrap.classList.remove("hidden");
			}
			el("chat-input").focus();
			e.preventDefault();
			return;
		}
		if (e.code === "Space") {
			e.preventDefault();
			if (!bombKeyDown) { bombKeyDown = true; startBombCharge(); }
			return;
		}
		if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
			e.preventDefault();
		}
		setKey(e.code, true);
	});

	window.addEventListener("keyup", (e) => {
		if (document.activeElement === el("chat-input")) return;
		if (e.code === "Space") { bombKeyDown = false; releaseBombCharge(); return; }
		setKey(e.code, false);
	});

	function setKey(code, val) {
		if (code === "KeyW" || code === "ArrowUp") keys.up = val;
		else if (code === "KeyS" || code === "ArrowDown") keys.down = val;
		else if (code === "KeyA" || code === "ArrowLeft") keys.left = val;
		else if (code === "KeyD" || code === "ArrowRight") keys.right = val;
	}

	canvas.addEventListener("mousemove", (e) => {
		const rect = canvas.getBoundingClientRect();
		mouseWorld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
	});
	canvas.addEventListener("mousedown", (e) => {
		if (document.activeElement === el("chat-input")) return;
		if (e.button === 0) doShoot();
	});
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());

	function doShoot() {
		if (ws && matchStarted && !matchOver) ws.send(JSON.stringify({ t: "shoot" }));
	}

	let charging = false, chargeStart = 0;
	function startBombCharge() {
		const me = getMe();
		if (!me || !me.alive || !matchStarted || matchOver || me.bombCount <= 0) return;
		charging = true; chargeStart = performance.now();
		if (ws) ws.send(JSON.stringify({ t: "bomb_start" }));
	}
	function releaseBombCharge() {
		if (!charging) return;
		charging = false;
		if (ws) ws.send(JSON.stringify({ t: "bomb_release" }));
	}

	const chatInput = el("chat-input");
	chatInput.addEventListener("focus", () => { keys.up = keys.down = keys.left = keys.right = false; });
	chatInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			const text = chatInput.value.trim();
			chatInput.value = ""; chatInput.blur();
			if (text && ws) ws.send(JSON.stringify({ t: "chat", text }));
			e.preventDefault();
		}
	});

	function sendInput() {
		if (!ws || ws.readyState !== WebSocket.OPEN || !matchStarted) return;
		const me = getMe();
		let aim = { x: 1, y: 0 };
		if (me) {
			const dx = mouseWorld.x - me.x, dy = mouseWorld.y - me.y;
			const len = Math.hypot(dx, dy) || 1;
			aim = { x: dx / len, y: dy / len };
		}
		ws.send(JSON.stringify({ t: "input", keys, aim }));
	}

	function getMe() { return state ? (state.players.find((p) => p.id === myId) || null) : null; }

	// -------- camera
	function computeCamera() {
		if (!state) return { cx: 640, cy: 360, scale: 1 };
		const arena = state.arena;
		const targetZoom = Math.min(2.2, Math.max(1.0, Math.max(arena.w, arena.h) / 1400));
		cameraZoom += (targetZoom - cameraZoom) * 0.03;
		const me = getMe();
		const center = me ? { x: me.x, y: me.y } : { x: arena.x + arena.w / 2, y: arena.y + arena.h / 2 };
		return { cx: center.x, cy: center.y, scale: 1 / cameraZoom };
	}

	function worldToScreen(x, y, cam) {
		return { x: canvas.width / 2 + (x - cam.cx) * cam.scale, y: canvas.height / 2 + (y - cam.cy) * cam.scale };
	}
	function screenToWorld(sx, sy) {
		const cam = computeCamera();
		return { x: cam.cx + (sx - canvas.width / 2) / cam.scale, y: cam.cy + (sy - canvas.height / 2) / cam.scale };
	}

	// -------- render loop
	function loop() {
		requestAnimationFrame(loop);
		if (!state) return;
		const cam = computeCamera();
		draw(cam);
		drawMinimap(cam);
		updateHud(cam);
	}

	function roundRectPath(x, y, w, h, r) {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	function drawObstacle(o, cam) {
		const tl = worldToScreen(o.x, o.y, cam), br = worldToScreen(o.x + o.w, o.y + o.h, cam);
		const w = br.x - tl.x, h = br.y - tl.y;
		const r = Math.min(8 * cam.scale, w * 0.25, h * 0.25);

		ctx.fillStyle = "rgba(0,0,0,0.35)";
		roundRectPath(tl.x + 3, tl.y + 5, w, h, r);
		ctx.fill();

		const grad = ctx.createLinearGradient(tl.x, tl.y, tl.x, br.y);
		grad.addColorStop(0, "#5b3fa0");
		grad.addColorStop(1, "#382865");
		ctx.fillStyle = grad;
		roundRectPath(tl.x, tl.y, w, h, r);
		ctx.fill();

		ctx.strokeStyle = "#b48bff"; ctx.lineWidth = 2;
		roundRectPath(tl.x, tl.y, w, h, r);
		ctx.stroke();

		ctx.fillStyle = "rgba(255,255,255,0.10)";
		roundRectPath(tl.x + 2, tl.y + 2, w - 4, h * 0.35, r * 0.7);
		ctx.fill();
	}

	function draw(cam) {
		ctx.fillStyle = "#0d0920";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const arena = state.arena;
		const aTL = worldToScreen(arena.x, arena.y, cam);
		const aBR = worldToScreen(arena.x + arena.w, arena.y + arena.h, cam);

		const grad = ctx.createRadialGradient(
			(aTL.x + aBR.x) / 2, (aTL.y + aBR.y) / 2, 10,
			(aTL.x + aBR.x) / 2, (aTL.y + aBR.y) / 2, Math.max(aBR.x - aTL.x, aBR.y - aTL.y) * 0.75
		);
		grad.addColorStop(0, "#2a1e5c");
		grad.addColorStop(1, "#1c1440");
		ctx.fillStyle = grad;
		ctx.fillRect(aTL.x, aTL.y, aBR.x - aTL.x, aBR.y - aTL.y);

		ctx.strokeStyle = "rgba(115,90,166,0.12)"; ctx.lineWidth = 1;
		for (let gx = arena.x; gx <= arena.x + arena.w; gx += 40) {
			const p1 = worldToScreen(gx, arena.y, cam), p2 = worldToScreen(gx, arena.y + arena.h, cam);
			ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
		}
		for (let gy = arena.y; gy <= arena.y + arena.h; gy += 40) {
			const p1 = worldToScreen(arena.x, gy, cam), p2 = worldToScreen(arena.x + arena.w, gy, cam);
			ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
		}

		ctx.strokeStyle = "#6b46b8"; ctx.lineWidth = 4;
		ctx.strokeRect(aTL.x, aTL.y, aBR.x - aTL.x, aBR.y - aTL.y);
		ctx.save();
		ctx.strokeStyle = "rgba(155,101,255,0.35)"; ctx.lineWidth = 12;
		ctx.strokeRect(aTL.x - 4, aTL.y - 4, aBR.x - aTL.x + 8, aBR.y - aTL.y + 8);
		ctx.restore();

		for (const o of state.obstacles) drawObstacle(o, cam);

		const t = performance.now() / 1000;
		for (const pu of state.powerups) {
			const s = worldToScreen(pu.x, pu.y, cam);
			const bob = Math.sin(t * 3) * 3;
			let color = "#7dffb0", icon = "➕";
			if (pu.type === "shield") { color = "#6fe3ff"; icon = "🛡"; }
			else if (pu.type === "bomb") { color = "#ffb15e"; icon = "💣"; }
			const blink = pu.life < 4 ? 0.4 + 0.6 * Math.abs(Math.sin(t * 10)) : 1;
			ctx.globalAlpha = blink;
			ctx.fillStyle = color;
			ctx.beginPath(); ctx.arc(s.x, s.y + bob, 11 * cam.scale, 0, Math.PI * 2); ctx.fill();
			ctx.font = `${16 * cam.scale}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
			ctx.fillText(icon, s.x, s.y + bob);
			ctx.globalAlpha = 1;
		}

		ctx.fillStyle = "#fff6a3";
		for (const b of state.bullets) {
			const s = worldToScreen(b.x, b.y, cam);
			ctx.beginPath(); ctx.arc(s.x, s.y, 5 * cam.scale, 0, Math.PI * 2); ctx.fill();
		}

		for (const b of state.bombs) {
			const s = worldToScreen(b.x, b.y, cam);
			if (!b.exploded) {
				ctx.fillStyle = "#2b2438";
				ctx.beginPath(); ctx.arc(s.x, s.y, 7 * cam.scale, 0, Math.PI * 2); ctx.fill();
				ctx.strokeStyle = "#ffb15e"; ctx.lineWidth = 2; ctx.stroke();
			} else {
				const r = (20 + b.explodeT * 140) * cam.scale;
				const a = Math.max(0, 1 - b.explodeT / 0.4);
				ctx.globalAlpha = a * 0.35; ctx.fillStyle = "#ff9933";
				ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
				ctx.globalAlpha = a; ctx.strokeStyle = "#ffcc66"; ctx.lineWidth = 3;
				ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
				ctx.globalAlpha = 1;
			}
		}

		for (const p of state.players) drawPlayer(p, cam);

		const me = getMe();
		if (me && charging) {
			const heldSec = Math.min(BOMB_MAX_CHARGE_TIME, (performance.now() - chargeStart) / 1000);
			const frac = heldSec / BOMB_MAX_CHARGE_TIME;
			const range = BOMB_RANGE_MIN + (BOMB_RANGE_MAX - BOMB_RANGE_MIN) * frac;
			const dx = mouseWorld.x - me.x, dy = mouseWorld.y - me.y;
			const len = Math.hypot(dx, dy) || 1;
			const tx = me.x + (dx / len) * range, ty = me.y + (dy / len) * range;
			const s0 = worldToScreen(me.x, me.y, cam), s1 = worldToScreen(tx, ty, cam);
			ctx.strokeStyle = "#ffb15e"; ctx.lineWidth = 2; ctx.setLineDash([6, 6]);
			ctx.beginPath(); ctx.moveTo(s0.x, s0.y); ctx.lineTo(s1.x, s1.y); ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = "rgba(255,177,94,0.7)";
			ctx.beginPath(); ctx.arc(s1.x, s1.y, (8 + frac * 6) * cam.scale, 0, Math.PI * 2); ctx.fill();
		}
	}

	const playerAnimMap = new Map();

	function drawPlayer(p, cam) {
		const s = worldToScreen(p.x, p.y, cam);
		const scale = 0.9 * cam.scale;

		let anim = playerAnimMap.get(p.id);
		if (!anim) {
			anim = { lastX: p.x, lastY: p.y, walkPhase: 0, isWalking: false, facingLeft: false };
			playerAnimMap.set(p.id, anim);
		}
		const dx = p.x - anim.lastX;
		const dy = p.y - anim.lastY;
		const movedDist = Math.hypot(dx, dy);
		anim.lastX = p.x;
		anim.lastY = p.y;

		let angle = 0;
		if (p.id === myId) {
			const mdx = mouseWorld.x - p.x, mdy = mouseWorld.y - p.y;
			angle = Math.atan2(mdy, mdx);
			anim.facingLeft = mdx < 0;
		} else if (p.aim) {
			angle = Math.atan2(p.aim.y, p.aim.x);
			if (p.aim.x !== 0) anim.facingLeft = p.aim.x < 0;
		}

		// Caminata: detecta movimiento al frente, atrás, lados y en diagonal ("a lo sesgado")
		const isMoving = movedDist > 0.35 || (p.id === myId && (keys.up || keys.down || keys.left || keys.right));
		if (isMoving) {
			anim.isWalking = true;
			const stepInc = movedDist > 0.35 ? movedDist * 0.16 : 0.22;
			anim.walkPhase += stepInc;
			if (p.id !== myId && (!p.aim || p.aim.x === 0) && Math.abs(dx) > 0.3) {
				anim.facingLeft = dx < 0;
			}
		} else {
			anim.isWalking = false;
		}

		drawGuardian(ctx, s.x, s.y, angle, p.color, scale, {
			alpha: p.alive ? 1 : 0.3,
			shield: p.shieldRemaining > 0,
			facingLeft: anim.facingLeft,
			walking: anim.isWalking && p.alive,
			walkPhase: anim.walkPhase,
			idlePhase: performance.now() / 420,
			showAimOrb: p.alive,
			bombCharging: (p.id === myId && charging) || p.bombCharging
		});

		const hex = colorHex(p.color);
		const bw = 44 * cam.scale;
		ctx.fillStyle = "#24162e"; ctx.fillRect(s.x - bw / 2, s.y - 35 * cam.scale, bw, 6 * cam.scale);
		ctx.fillStyle = hex; ctx.fillRect(s.x - bw / 2, s.y - 35 * cam.scale, bw * (p.hp / p.maxHp), 6 * cam.scale);

		ctx.fillStyle = "#fff"; ctx.font = `${13 * cam.scale}px sans-serif`;
		ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
		ctx.fillText(p.name, s.x - bw / 2, s.y - 40 * cam.scale);

		if (p.penalized && p.alive) {
			ctx.fillStyle = "#ff5e5e"; ctx.font = `${13 * cam.scale}px sans-serif`;
			ctx.textAlign = "center"; ctx.fillText("⚠", s.x, s.y - 46 * cam.scale);
		}
		if (!p.alive) {
			ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = `${16 * cam.scale}px sans-serif`;
			ctx.fillText("KO", s.x, s.y + 4 * cam.scale);
		}
		if (p.id === myId) {
			ctx.fillStyle = "#7dffb0";
			ctx.beginPath(); ctx.arc(s.x, s.y + 26 * cam.scale, 3, 0, Math.PI * 2); ctx.fill();
		}
	}

	function drawMinimap(cam) {
		const w = minimap.width, h = minimap.height;
		mctx.clearRect(0, 0, w, h);
		mctx.fillStyle = "rgba(13,10,31,0.4)"; mctx.fillRect(0, 0, w, h);

		const arena = state.arena;
		const pad = 8;
		const sx = (w - pad * 2) / arena.w, sy = (h - pad * 2) / arena.h;
		const s = Math.min(sx, sy);
		const ox = pad, oy = pad;
		const toMap = (x, y) => ({ x: ox + (x - arena.x) * s, y: oy + (y - arena.y) * s });

		mctx.strokeStyle = "#6b46b8"; mctx.lineWidth = 2;
		mctx.strokeRect(ox, oy, arena.w * s, arena.h * s);

		mctx.fillStyle = "rgba(139,111,214,0.5)";
		for (const o of state.obstacles) { const p = toMap(o.x, o.y); mctx.fillRect(p.x, p.y, o.w * s, o.h * s); }

		const myTarget = state.myTarget;
		const t = performance.now() / 1000;
		for (const p of state.players) {
			if (!p.alive) continue;
			const hex = colorHex(p.color);
			const mp = toMap(p.x, p.y);
			if (p.color === myTarget && p.id !== myId) {
				const pulse = 5 + 2 * Math.abs(Math.sin(t * 6));
				mctx.strokeStyle = "#fff"; mctx.lineWidth = 1.2;
				mctx.beginPath(); mctx.arc(mp.x, mp.y, pulse, 0, Math.PI * 2); mctx.stroke();
			}
			if (p.id === myId) {
				mctx.fillStyle = "#fff";
				mctx.beginPath(); mctx.arc(mp.x, mp.y, 4.5, 0, Math.PI * 2); mctx.fill();
				mctx.fillStyle = hex;
				mctx.beginPath(); mctx.arc(mp.x, mp.y, 3, 0, Math.PI * 2); mctx.fill();
			} else {
				mctx.fillStyle = hex;
				mctx.beginPath(); mctx.arc(mp.x, mp.y, 2.6, 0, Math.PI * 2); mctx.fill();
			}
		}

		const me = getMe();
		if (me) {
			const viewW = canvas.width / cam.scale, viewH = canvas.height / cam.scale;
			const vtl = toMap(cam.cx - viewW / 2, cam.cy - viewH / 2);
			mctx.strokeStyle = "rgba(255,255,255,0.6)"; mctx.lineWidth = 1.5;
			mctx.strokeRect(vtl.x, vtl.y, viewW * s, viewH * s);
		}
	}

	// -------- HUD
	let toastTimer = 0;
	function showToast(text, color) {
		const box = el("hud-toast");
		box.textContent = text; box.style.color = color || "#fff";
		box.classList.remove("hidden"); toastTimer = 3.0;
		if (text.includes("15 SEGUNDOS")) Sound.warning();
		else if (text.includes("nuevos colores") || text.includes("Nuevos colores") || text.includes("Nuevos")) Sound.collapse();
		else if (text.includes("eliminado")) Sound.eliminated();
		else if (text.includes("botiquín")) Sound.powerup();
		else if (text.includes("burbuja")) Sound.powerup();
		else if (text.includes("recogió")) Sound.powerup();
		else if (text.includes("bomba")) Sound.explosion();
		else if (text.includes("eliminó a su objetivo")) Sound.hit();
	}
	setInterval(() => {
		if (toastTimer > 0) { toastTimer -= 0.2; if (toastTimer <= 0) el("hud-toast").classList.add("hidden"); }
	}, 200);

	let chatHidden = false;
	const chatWrap = el("chat-wrap");
	function toggleChat() {
		if (!chatWrap) return;
		chatHidden = !chatHidden;
		chatWrap.classList.toggle("hidden", chatHidden);
		showToast(chatHidden ? "Chat oculto [Presiona C o TAB para ver]" : "Chat visible [Presiona C o TAB para ocultar]", "#bcaade");
	}

	function leaveGamePrompt() {
		if (!matchStarted || matchOver) return;
		if (confirm("¿Deseas salir de la partida y regresar a la sala principal?")) {
			Sound.stopMusic();
			if (ws) {
				try { ws.close(); } catch (_) {}
			}
			window.location.reload();
		}
	}

	// ESC funciona desde cualquier pantalla: sala de espera, partida en curso
	// o resultados finales. Antes solo salía de una partida activa; ahora
	// siempre hay una forma de salir con ESC sin quedar atrapado.
	function handleEscape() {
		if (matchOver) {
			// Pantalla de ranking / resultados finales
			Sound.stopMusic();
			if (ws) { try { ws.close(); } catch (_) {} }
			window.location.reload();
			return;
		}
		if (matchStarted) {
			leaveGamePrompt();
			return;
		}
		const waitingPanel = el("waiting-panel");
		if (waitingPanel && !waitingPanel.classList.contains("hidden")) {
			// Sala de espera (aún no inicia la partida)
			if (confirm("¿Deseas salir de la sala?")) {
				if (ws) { try { ws.close(); } catch (_) {} }
				window.location.reload();
			}
		}
	}

	function addChatLine(name, text) {
		const log = el("chat-log");
		const line = document.createElement("div");
		line.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
		log.appendChild(line);
		while (log.children.length > 8) log.removeChild(log.firstChild);
		log.scrollTop = log.scrollHeight;
		if (chatHidden) {
			showToast(`💬 ${name}: ${text.slice(0, 35)} [C o TAB]`, "#ffd34e");
		}
	}
	function escapeHtml(s) {
		return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
	}

	let lastShootSoundBullets = 0;
	function updateHud() {
		const aliveN = state.players.filter((p) => p.alive).length;
		el("hud-alive").textContent = `👥 VIVOS  ${aliveN}`;

		if (matchOver) {
			el("hud-timer").textContent = "";
		} else {
			const m = Math.floor(state.roundTimer / 60), sec = Math.floor(state.roundTimer % 60);
			el("hud-timer").textContent = `⏱ ${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
		}

		if (state.bullets.length > lastShootSoundBullets) Sound.shoot();
		lastShootSoundBullets = state.bullets.length;

		const swatch = el("target-swatch");
		if (state.myTarget) {
			swatch.style.background = colorHex(state.myTarget);
			swatch.style.color = colorHex(state.myTarget);
			el("target-name").textContent = colorName(state.myTarget);
		}
		const penaltyEl = el("hud-penalty");
		if (matchOver) {
			penaltyEl.classList.add("hidden");
		} else if (state.myTargetEliminated) {
			penaltyEl.textContent = "✔ ¡PRESA ELIMINADA! Conservas tu vida esta ronda";
			penaltyEl.className = "target-safe";
			penaltyEl.classList.remove("hidden");
		} else if (state.myPenalized) {
			penaltyEl.textContent = "⚠ ¡TIEMPO AGOTÁNDOSE! Elimina a tu presa o perderás 1 porción de vida";
			penaltyEl.className = "target-danger";
			penaltyEl.classList.remove("hidden");
		} else {
			penaltyEl.classList.add("hidden");
		}

		const me = getMe();
		if (me) {
			el("me-name").textContent = `● ${me.name}`;
			el("me-name").style.color = colorHex(me.color);
			el("me-hp-bar").style.width = `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
			el("me-hp-text").textContent = `❤ ${me.hp} / ${me.maxHp} HP`;
			el("me-bomb-text").textContent = `💣 Bombas: ${me.bombCount} / ${BOMB_MAX}`;
			el("me-shield-text").textContent = me.shieldRemaining > 0 ? `🛡 Burbuja: ${Math.ceil(me.shieldRemaining)}s` : "🛡 Burbuja: —";
		}

		el("btn-leave-game").classList.toggle("hidden", !matchOver);
	}

	// -------- ranking
	function showRanking(msg) {
		Sound.stopMusic();
		Sound.victory();
		el("hud-message").textContent = msg.winnerName ? `🏆 ${msg.winnerName} GANA` : "🤝 PARTIDA TERMINADA";
		const list = el("ranking-list");
		list.innerHTML = "";
		const medals = ["🥇", "🥈", "🥉"];
		msg.standings.forEach((row, i) => {
			const div = document.createElement("div");
			div.className = "rank-row";
			div.style.color = colorHex(row.color);
			const tag = i < 3 ? medals[i] : `${i + 1}°`;
			div.textContent = `${tag}   ${row.name}  —  ${colorName(row.color)}`;
			list.appendChild(div);
		});
		el("ranking-overlay").classList.remove("hidden");
	}
})();
