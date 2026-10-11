// sound.js — efectos sintetizados con Web Audio API (sin archivos .wav/.mp3
// que servir). Se crea el AudioContext en el primer clic/tecla del usuario
// porque los navegadores bloquean el audio autoplay.

const Sound = (() => {
	let ctx = null;
	let masterGain = null;
	let volume = 0.8;
	let muted = false;

	function ensure() {
		if (!ctx) {
			ctx = new (window.AudioContext || window.webkitAudioContext)();
			masterGain = ctx.createGain();
			masterGain.gain.value = muted ? 0 : volume;
			masterGain.connect(ctx.destination);
		}
		if (ctx.state === "suspended") ctx.resume();
		return ctx;
	}

	function tone(freqFrom, freqTo, dur, vol = 0.4, type = "sine") {
		if (muted) return;
		const c = ensure();
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(freqFrom, c.currentTime);
		osc.frequency.linearRampToValueAtTime(freqTo, c.currentTime + dur);
		gain.gain.setValueAtTime(0.0001, c.currentTime);
		gain.gain.linearRampToValueAtTime(vol, c.currentTime + Math.min(0.02, dur * 0.2));
		gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
		osc.connect(gain).connect(masterGain || c.destination);
		osc.start();
		osc.stop(c.currentTime + dur + 0.02);
	}

	function noiseBurst(dur, vol = 0.3) {
		if (muted) return;
		const c = ensure();
		const bufferSize = Math.floor(c.sampleRate * dur);
		const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
		const data = buffer.getChannelData(0);
		for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-3 * (i / bufferSize));
		const src = c.createBufferSource();
		src.buffer = buffer;
		const gain = c.createGain();
		gain.gain.value = vol;
		src.connect(gain).connect(masterGain || c.destination);
		src.start();
	}

	let musicState = null;
	let lobbyMusicState = null;
	let lobbyMusicEnabled = true;

	// -------- MOTOR CHIPTUNE (estilo música de videojuego de píxeles 8-bit) --------
	// Un "step sequencer" clásico: onda cuadrada/pulso para la melodía, onda
	// triangular para el bajo, y ráfagas cortas de ruido a modo de percusión,
	// tal como sonaban los juegos retro de 8/16 bits.

	function midiToFreq(n) {
		return 440 * Math.pow(2, (n - 69) / 12);
	}

	// Nota de "pulso" 8-bit: cuadrada con un leve vibrato/arpegio y decaimiento
	// escalonado (envolvente tipo "chip" en lugar de una rampa suave).
	function playChipLead(c, dest, freq, time, dur, vol = 0.12, duty = "square") {
		const osc = c.createOscillator();
		osc.type = duty;
		osc.frequency.setValueAtTime(freq, time);
		const gain = c.createGain();
		// Envolvente escalonada (staircase) típica de un canal de pulso de NES/GB
		gain.gain.setValueAtTime(vol, time);
		gain.gain.setValueAtTime(vol * 0.85, time + dur * 0.35);
		gain.gain.setValueAtTime(vol * 0.5, time + dur * 0.7);
		gain.gain.setValueAtTime(0.0001, time + dur * 0.98);
		osc.connect(gain).connect(dest);
		osc.start(time);
		osc.stop(time + dur + 0.02);
	}

	function playChipBass(c, dest, freq, time, dur, vol = 0.22) {
		const osc = c.createOscillator();
		osc.type = "triangle";
		osc.frequency.setValueAtTime(freq, time);
		const gain = c.createGain();
		gain.gain.setValueAtTime(vol, time);
		gain.gain.setValueAtTime(0.0001, time + dur * 0.92);
		osc.connect(gain).connect(dest);
		osc.start(time);
		osc.stop(time + dur + 0.02);
	}

	// "Hi-hat" de ruido corto, como el canal de ruido de una consola de 8 bits
	function playChipHat(c, dest, time, vol = 0.06, dur = 0.035) {
		const bufferSize = Math.max(1, Math.floor(c.sampleRate * dur));
		const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
		const data = buffer.getChannelData(0);
		for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
		const src = c.createBufferSource();
		src.buffer = buffer;
		const filter = c.createBiquadFilter();
		filter.type = "highpass";
		filter.frequency.value = 5000;
		const gain = c.createGain();
		gain.gain.value = vol;
		src.connect(filter).connect(gain).connect(dest);
		src.start(time);
	}

	// Motor genérico de secuenciador por pasos, reutilizado por la música del
	// lobi y la música dentro de la partida (solo cambia el patrón/tempo).
	function makeChipSequencer({ bpm, bassPattern, leadPattern, hatEvery, gainLevel, duty }) {
		const stepDur = 60 / bpm / 2; // corcheas
		let stepIndex = 0;
		let master = null;
		let interval = null;

		function scheduleStep(c) {
			const now = c.currentTime + 0.02;
			const bassNote = bassPattern[stepIndex % bassPattern.length];
			const leadNote = leadPattern[stepIndex % leadPattern.length];

			if (bassNote != null) {
				playChipBass(c, master, midiToFreq(bassNote), now, stepDur * 1.9, gainLevel.bass);
			}
			if (leadNote != null) {
				playChipLead(c, master, midiToFreq(leadNote), now, stepDur * 0.95, gainLevel.lead, duty);
			}
			if (hatEvery && stepIndex % hatEvery === 0) {
				playChipHat(c, master, now, gainLevel.hat);
			}
			stepIndex++;
		}

		return {
			start(c, destGain, onStateChange) {
				master = c.createGain();
				master.gain.setValueAtTime(0.0001, c.currentTime);
				master.gain.linearRampToValueAtTime(1.0, c.currentTime + 0.5);
				master.connect(destGain);
				stepIndex = 0;
				scheduleStep(c);
				interval = setInterval(() => scheduleStep(c), stepDur * 1000);
				if (onStateChange) onStateChange(true);
			},
			stop(c, onStateChange) {
				if (interval) clearInterval(interval);
				interval = null;
				if (master) {
					try {
						master.gain.setValueAtTime(master.gain.value, c.currentTime);
						master.gain.linearRampToValueAtTime(0.0001, c.currentTime + 0.4);
					} catch (e) { /* ignore */ }
				}
				master = null;
				if (onStateChange) onStateChange(false);
			},
		};
	}

	// Melodía alegre y sencilla estilo "pantalla de menú" de un juego de plataformas
	// de 8 bits (escala de Do mayor), a un tempo relajado.
	const LOBBY_BASS = [48, null, 48, 55, 53, null, 53, 43];
	const LOBBY_LEAD = [72, 76, 79, 76, 74, 77, 72, 69, 71, 74, 77, 74, 72, 76, 74, 72];
	const lobbySequencer = makeChipSequencer({
		bpm: 108,
		bassPattern: LOBBY_BASS,
		leadPattern: LOBBY_LEAD,
		hatEvery: 4,
		gainLevel: { bass: 0.15, lead: 0.09, hat: 0.04 },
		duty: "square",
	});

	// Melodía de "acción/combate" más rápida e intensa para dentro de la partida.
	const GAME_BASS = [45, 45, 52, 45, 48, 48, 50, 48];
	const GAME_LEAD = [69, 72, 76, 72, 71, 74, 77, 74, 67, 71, 74, 71, 69, 72, 76, 79];
	const gameSequencer = makeChipSequencer({
		bpm: 150,
		bassPattern: GAME_BASS,
		leadPattern: GAME_LEAD,
		hatEvery: 2,
		gainLevel: { bass: 0.17, lead: 0.1, hat: 0.05 },
		duty: "square",
	});

	function startLobbyMusic() {
		if (muted || !lobbyMusicEnabled) return;
		const c = ensure();
		if (lobbyMusicState) return;
		lobbySequencer.start(c, masterGain || c.destination, (playing) => {
			if (typeof window !== "undefined" && window.updateLobbyMusicUI) window.updateLobbyMusicUI(playing);
		});
		lobbyMusicState = true;
	}

	function stopLobbyMusic() {
		if (!lobbyMusicState) return;
		const c = ensure();
		lobbySequencer.stop(c, (playing) => {
			if (typeof window !== "undefined" && window.updateLobbyMusicUI) window.updateLobbyMusicUI(playing);
		});
		lobbyMusicState = null;
	}

	function toggleLobbyMusic() {
		lobbyMusicEnabled = !lobbyMusicEnabled;
		if (lobbyMusicEnabled) {
			startLobbyMusic();
		} else {
			stopLobbyMusic();
		}
		return lobbyMusicEnabled;
	}

	function startMusic() {
		stopLobbyMusic();
		if (muted) return;
		const c = ensure();
		if (musicState) return;
		gameSequencer.start(c, masterGain || c.destination);
		musicState = true;
	}

	function stopMusic() {
		if (!musicState) return;
		const c = ensure();
		gameSequencer.stop(c);
		musicState = null;
	}

	function setVolume(v) {
		volume = Math.max(0, Math.min(1, v));
		if (masterGain && ctx) {
			masterGain.gain.setValueAtTime(muted ? 0 : volume, ctx.currentTime);
		}
	}

	function setMuted(m) {
		muted = !!m;
		if (masterGain && ctx) {
			masterGain.gain.setValueAtTime(muted ? 0 : volume, ctx.currentTime);
		}
		if (muted) {
			if (musicState) stopMusic();
			if (lobbyMusicState) stopLobbyMusic();
		} else {
			if (lobbyMusicEnabled && !musicState) {
				startLobbyMusic();
			}
		}
	}

	return {
		unlock() { ensure(); },
		startMusic,
		stopMusic,
		startLobbyMusic,
		stopLobbyMusic,
		toggleLobbyMusic,
		isLobbyMusicPlaying: () => !!lobbyMusicState && !muted && lobbyMusicEnabled,
		isLobbyMusicEnabled: () => lobbyMusicEnabled,
		setVolume,
		setMuted,
		isMuted: () => muted,
		getVolume: () => volume,
		shoot() { tone(1400, 700, 0.09, 0.25, "square"); },
		hit() { tone(220, 90, 0.12, 0.3, "sawtooth"); noiseBurst(0.08, 0.15); },
		warning() { tone(700, 700, 0.13, 0.3); setTimeout(() => tone(700, 700, 0.13, 0.3), 210); },
		collapse() { tone(950, 300, 0.7, 0.3, "sawtooth"); },
		eliminated() { tone(520, 140, 0.55, 0.3, "triangle"); },
		victory() { tone(523, 720, 0.3, 0.25); setTimeout(() => tone(659, 900, 0.3, 0.25), 120); },
		powerup() { tone(700, 1050, 0.35, 0.3); },
		explosion() { tone(120, 40, 0.5, 0.35, "sawtooth"); noiseBurst(0.4, 0.35); },
		click() { tone(900, 900, 0.045, 0.2); },
	};
})();
