import { useEffect, useRef } from 'react';

/** Paint microphone samples directly; recording never depends on visualizer support. */
export default function DictationWaveform({ stream }: { stream: MediaStream }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = canvasRef.current;
		const painter = canvas?.getContext('2d');
		if (!canvas || !painter) return;
		let audio: AudioContext | undefined;
		let source: MediaStreamAudioSourceNode | undefined;
		let analyser: AnalyserNode | undefined;
		let animation = 0;
		let disposed = false;
		let width = 0;
		let height = 0;
		let lastFrame = 0;
		let cursor = 0;
		const levels = new Float32Array(96);
		let samples: Float32Array<ArrayBuffer> | undefined;
		let bytes: Uint8Array<ArrayBuffer> | undefined;
		function resize() {
			if (!canvas || !painter) return;
			const rect = canvas.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			const scale = Math.min(2, window.devicePixelRatio || 1);
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			painter.setTransform(scale, 0, 0, scale, 0, 0);
		}
		const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
		observer?.observe(canvas);
		if (!observer) window.addEventListener('resize', resize, { passive: true });
		resize();
		try {
			const Audio =
				window.AudioContext ||
				(window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (Audio) {
				audio = new Audio();
				source = audio.createMediaStreamSource(stream);
				analyser = audio.createAnalyser();
				analyser.fftSize = 256;
				analyser.smoothingTimeConstant = 0.65;
				source.connect(analyser);
				samples = new Float32Array(analyser.fftSize);
				bytes = new Uint8Array(analyser.fftSize);
				void audio.resume().catch(() => {});
			}
		} catch {
			// Unsupported visualization leaves a quiet line rather than invented activity.
		}
		function draw(time: number) {
			if (disposed || !canvas || !painter) return;
			animation = requestAnimationFrame(draw);
			if (time - lastFrame < 33) return;
			lastFrame = time;
			let energy = 0;
			try {
				if (analyser && samples && typeof analyser.getFloatTimeDomainData === 'function') {
					analyser.getFloatTimeDomainData(samples);
					for (const sample of samples) energy += sample * sample;
					energy = Math.sqrt(energy / samples.length);
				} else if (analyser && bytes) {
					analyser.getByteTimeDomainData(bytes);
					for (const byte of bytes) energy += ((byte - 128) / 128) ** 2;
					energy = Math.sqrt(energy / bytes.length);
				}
			} catch {
				energy = 0;
			}
			levels[cursor] = Math.min(1, Math.max(0, energy - 0.004) * 7);
			cursor = (cursor + 1) % levels.length;
			painter.clearRect(0, 0, width, height);
			painter.strokeStyle = getComputedStyle(canvas).color;
			painter.lineWidth = 2;
			painter.lineCap = 'round';
			const columns = Math.min(levels.length, Math.max(1, Math.floor(width / 5)));
			const spacing = width / columns;
			painter.beginPath();
			for (let index = 0; index < columns; index++) {
				const level = levels[(cursor + levels.length - columns + index) % levels.length];
				const bar = Math.max(1, level * Math.max(1, height - 4));
				const x = (index + 0.5) * spacing;
				painter.moveTo(x, (height - bar) / 2);
				painter.lineTo(x, (height + bar) / 2);
			}
			painter.stroke();
		}
		animation = requestAnimationFrame(draw);
		return () => {
			disposed = true;
			cancelAnimationFrame(animation);
			observer?.disconnect();
			if (!observer) window.removeEventListener('resize', resize);
			try {
				source?.disconnect();
			} catch {}
			try {
				analyser?.disconnect();
			} catch {}
			if (audio && audio.state !== 'closed') void audio.close().catch(() => {});
		};
	}, [stream]);
	return (
		<canvas
			ref={canvasRef}
			className="dictation-waveform"
			role="img"
			aria-label="Live microphone waveform"
		/>
	);
}
