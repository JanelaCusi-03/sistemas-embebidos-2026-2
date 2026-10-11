// guardian.js — tu personaje real ("Guardián de Colores"), reconstruido a
// partir del SVG que compartiste. Se recolorea por equipo (reemplaza
// var(--main) por el hex del color asignado) y se pre-renderiza como
// imagen para poder dibujarlo rápido y rotado en el <canvas> del juego.

const GUARDIAN_INK = "#090d18";
const GUARDIAN_LINE = "#121a2e";
const GUARDIAN_VB_W = 560;
const GUARDIAN_VB_H = 650;

function guardianSvgMarkup(mainHex) {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GUARDIAN_VB_W} ${GUARDIAN_VB_H}">
<g stroke="${GUARDIAN_LINE}" stroke-width="8" stroke-linejoin="round">
<path d="M182 142 L143 83 Q139 58 164 67 L214 97 Z" fill="${mainHex}"/>
<path d="M378 142 L417 83 Q421 58 396 67 L346 97 Z" fill="${mainHex}"/>
<path d="M148 169 C149 92 202 43 280 43 C358 43 411 92 412 169 L400 267 C391 321 347 350 280 351 C213 350 169 321 160 267 Z" fill="${mainHex}"/>
<path d="M222 66 L251 111 L280 132 L309 111 L338 66 L314 49 L280 43 L246 49 Z" fill="${mainHex}" stroke-width="5"/>
<path d="M157 186 Q193 204 226 198 L245 222 L280 226 L315 222 L334 198 Q367 204 403 186 L396 267 Q355 316 280 317 Q205 316 164 267 Z" fill="${mainHex}" stroke-width="7"/>
<path d="M176 204 Q205 218 230 214 L247 238 L280 243 L313 238 L330 214 Q355 218 384 204 L376 264 L341 286 L219 286 L184 264 Z" fill="${GUARDIAN_INK}" stroke-width="5"/>
<path d="M193 222 L221 230 L214 264 L188 253 Z M367 222 L339 230 L346 264 L372 253 Z" fill="#d8dde6" stroke-width="4"/>
<path d="M255 278 L305 278 L297 300 Q280 308 263 300 Z" fill="#cbd2dc" stroke-width="4"/>
<path d="M168 353 C117 350 84 387 94 440 C100 475 121 495 154 494 L194 451 Z" fill="${mainHex}"/>
<path d="M392 353 C443 350 476 387 466 440 C460 475 439 495 406 494 L366 451 Z" fill="${mainHex}"/>
<path d="M194 336 C198 288 232 262 280 262 C328 262 362 288 366 336 L358 469 C354 519 323 548 280 550 C237 548 206 519 202 469 Z" fill="${mainHex}"/>
<path d="M215 365 L252 336 L280 364 L308 336 L345 365 L337 454 L280 486 L223 454 Z" fill="${mainHex}" stroke-width="4"/>
<path d="M201 447 L359 447 L359 477 L201 477 Z" fill="${GUARDIAN_INK}" stroke-width="5"/>
<rect x="251" y="441" width="58" height="42" rx="10" fill="#e7ebf2" stroke-width="6"/>
<circle cx="280" cy="462" r="9" fill="${mainHex}" stroke="${mainHex}"/>
<path d="M205 451 L253 478 L244 579 L171 608 L151 584 L190 538 Z" fill="${mainHex}"/>
<path d="M355 451 L307 478 L316 579 L389 608 L409 584 L370 538 Z" fill="${mainHex}"/>
<path d="M165 578 Q200 565 247 586 L252 615 Q209 638 158 616 Q153 597 165 578 Z" fill="${mainHex}"/>
<path d="M395 578 Q360 565 313 586 L308 615 Q351 638 402 616 Q407 597 395 578 Z" fill="${mainHex}"/>
<path d="M184 411 L143 423 Q116 433 105 461 Q101 479 117 487 Q132 493 149 480 L205 451 Z" fill="${mainHex}"/>
<path d="M376 411 L417 423 Q444 433 455 461 Q459 479 443 487 Q428 493 411 480 L355 451 Z" fill="${mainHex}"/>
<path d="M143 423 L222 403 Q239 399 249 414 L238 438 L161 455 Z" fill="${mainHex}"/>
<path d="M417 423 L338 403 Q321 399 311 414 L322 438 L399 455 Z" fill="${mainHex}"/>
<path d="M218 421 L280 392 L342 421 L319 448 L280 430 L241 448 Z" fill="#dce2eb" stroke-width="6"/>
<path d="M240 407 L280 374 L320 407" fill="none" stroke="${mainHex}" stroke-width="14" stroke-linecap="round"/>
<path d="M252 397 L280 364 L308 397 L280 416 Z" fill="#dce2eb" stroke-width="6"/>
<path d="M280 365 L280 315" fill="none" stroke="#dce2eb" stroke-width="10" stroke-linecap="round"/>
<path d="M263 320 L280 294 L297 320" fill="${mainHex}" stroke-width="5"/>
</g>
</svg>`;
}

const GUARDIAN_IMAGES = {}; // colorKey -> HTMLImageElement

function buildGuardianImages() {
	for (const g of GROUP_COLORS) {
		const svg = guardianSvgMarkup(g.hex);
		const img = new Image();
		img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
		GUARDIAN_IMAGES[g.key] = img;
	}
	// imagen de vista previa (lobby), antes de que se asigne color real
	const previewImg = new Image();
	previewImg.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(guardianSvgMarkup("#c9a6ff"));
	GUARDIAN_IMAGES["__preview"] = previewImg;
}
buildGuardianImages();

// Dibuja el guardián centrado en (x,y), SIEMPRE DE PIE (parado, sin girar como botella),
// con animación de caminata al frente, atrás y a lo sesgado/diagonal, volteando
// horizontalmente hacia donde apunta o camina, y mostrando su orbe de puntería.
function drawGuardian(ctx, x, y, angle, colorKey, scale, opts) {
	opts = opts || {};
	const img = GUARDIAN_IMAGES[colorKey] || GUARDIAN_IMAGES["__preview"];
	const s = (scale || 1) * 0.082;
	const w = GUARDIAN_VB_W * s, h = GUARDIAN_VB_H * s;
	const isWalking = !!opts.walking;
	const walkPhase = opts.walkPhase || 0;
	const idlePhase = opts.idlePhase || 0;
	const facingLeft = !!opts.facingLeft;

	ctx.save();
	ctx.translate(x, y);

	// 1. Sombra en el piso (reacciona sutilmente al paso)
	const shadowScale = isWalking ? 1 - Math.abs(Math.sin(walkPhase)) * 0.12 : 1;
	ctx.fillStyle = "rgba(0,0,0,0.38)";
	ctx.beginPath();
	ctx.ellipse(0, h * 0.42, 16 * (scale || 1) * shadowScale, 6.5 * (scale || 1) * shadowScale, 0, 0, Math.PI * 2);
	ctx.fill();

	// 2. Escudo / Burbuja protectora
	if (opts.shield) {
		ctx.fillStyle = "rgba(111,227,255,0.18)";
		ctx.beginPath(); ctx.arc(0, 0, w * 0.65, 0, Math.PI * 2); ctx.fill();
		ctx.strokeStyle = "#6fe3ff"; ctx.lineWidth = 2.5 * (scale || 1); ctx.stroke();
	}

	// 3. Orbe de Puntería / Apuntado (indica hacia dónde dispara sin voltear el cuerpo como botella)
	if (opts.showAimOrb && angle != null && opts.alpha !== 0.3) {
		const aimDist = 27 * (scale || 1);
		const orbX = Math.cos(angle) * aimDist;
		const orbY = Math.sin(angle) * aimDist;
		const orbR = (opts.bombCharging ? 6.5 : 4.5) * (scale || 1);

		// Línea de puntería corta y elegante
		ctx.save();
		ctx.strokeStyle = "rgba(255,255,255,0.35)";
		ctx.lineWidth = 1.5;
		ctx.setLineDash([3, 3]);
		ctx.beginPath();
		ctx.moveTo(orbX * 0.4, orbY * 0.4);
		ctx.lineTo(orbX, orbY);
		ctx.stroke();

		// Resplandor del orbe
		const colorHex = GROUP_COLORS.find(g => g.key === colorKey)?.hex || "#c9a6ff";
		ctx.fillStyle = colorHex;
		ctx.shadowColor = colorHex;
		ctx.shadowBlur = opts.bombCharging ? 14 : 7;
		ctx.beginPath();
		ctx.arc(orbX, orbY, orbR, 0, Math.PI * 2);
		ctx.fill();

		// Centro brillante del orbe
		ctx.fillStyle = "#ffffff";
		ctx.beginPath();
		ctx.arc(orbX - orbR * 0.25, orbY - orbR * 0.25, orbR * 0.4, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}

	// 4. Transformaciones del personaje SIEMPRE PARADO
	// Calculamos rebote y bamboleo de caminata (adelante, atrás o diagonal)
	let stepY = 0;
	let tilt = 0;
	let squishX = 1;
	let squishY = 1;

	if (isWalking) {
		// Pasitos firmes: rebote vertical al caminar
		stepY = -Math.abs(Math.sin(walkPhase)) * 4.5 * (scale || 1);
		// Inclinación rítmica lateral de paso (±3.8 grados)
		tilt = Math.sin(walkPhase) * 0.065;
		// Deformación elástica de zancada
		squishX = 1 + Math.sin(walkPhase * 2) * 0.035;
		squishY = 1 - Math.sin(walkPhase * 2) * 0.035;
	} else {
		// Respiración relajada cuando está quieto
		stepY = Math.sin(idlePhase) * 1.5 * (scale || 1);
	}

	// Aplicamos orientación: mirar a la izquierda o a la derecha
	if (facingLeft) {
		ctx.scale(-1, 1);
	}
	ctx.translate(0, stepY);
	ctx.rotate(tilt);
	ctx.scale(squishX, squishY);

	// 5. Dibujar imagen del guardián de pie
	ctx.globalAlpha = opts.alpha != null ? opts.alpha : 1;
	if (img && img.complete && img.naturalWidth > 0) {
		ctx.drawImage(img, -w / 2, -h / 2, w, h);
	} else {
		ctx.fillStyle = "#888";
		ctx.beginPath(); ctx.arc(0, 0, w * 0.3, 0, Math.PI * 2); ctx.fill();
	}
	ctx.restore();
}
