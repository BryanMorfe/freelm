let playing: HTMLAudioElement | undefined;
/** A single playback path; never queue stale sounds or overlap previews and replies. */
export async function playBotResponseSound(volume: number, kind?: 'message'): Promise<void> {
  if (!Number.isFinite(volume) || volume <= 0 || volume > 1) return;
  playing?.pause();
  const audio = new Audio(
    kind === 'message'
      ? new URL('../assets/bot-message.wav', import.meta.url).href
      : new URL('../assets/bot-response.wav', import.meta.url).href,
  );
  playing = audio;
  audio.volume = volume;
  try {
    await audio.play();
  } finally {
    if (playing === audio)
      audio.onended = () => {
        if (playing === audio) playing = undefined;
      };
  }
}
