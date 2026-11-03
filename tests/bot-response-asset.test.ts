import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('ships the same clean +6 dB, 420 ms PCM chime on desktop and iOS', () => {
  const audio = readFileSync(new URL('../src/assets/bot-response.wav', import.meta.url));
  const ios = readFileSync(
    new URL('../../FreeLMBots/FreeLMBots/bot-response.wav', import.meta.url),
  );
  expect(audio.equals(ios)).toBe(true);
  expect(audio.toString('ascii', 0, 4)).toBe('RIFF');
  expect(audio.readUInt16LE(22)).toBe(1);
  expect(audio.readUInt32LE(24)).toBe(44100);
  expect(audio.readUInt16LE(34)).toBe(16);
  let offset = 12,
    data: Buffer | undefined;
  while (offset + 8 <= audio.length) {
    const size = audio.readUInt32LE(offset + 4);
    if (audio.toString('ascii', offset, offset + 4) === 'data')
      data = audio.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  expect(data).toBeDefined();
  const samples = Array.from(
    { length: data!.length / 2 },
    (_, i) => data!.readInt16LE(i * 2) / 32768,
  );
  const peak = Math.max(...samples.map(Math.abs));
  const rms = Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length);
  expect(samples.length / 44100).toBeCloseTo(0.42, 5);
  expect(20 * Math.log10(peak)).toBeCloseTo(-12.23093, 3);
  expect(20 * Math.log10(rms)).toBeCloseTo(-22.6445, 3);
  expect(peak).toBeLessThan(1);
});
