import { useState } from 'react';
import { defaultBotResponseSound, type BotResponseSound } from '../notification-types';
import { playBotResponseSound } from '../lib/bot-response-sound';
import { SettingsRow } from './SettingsList';
import Switch from './Switch';
export default function BotSoundSettings({
  value = defaultBotResponseSound,
  onChange,
  disabled = false,
}: {
  value?: BotResponseSound;
  onChange(value: BotResponseSound): void;
  disabled?: boolean;
}) {
  const [error, setError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  return (
    <>
      <SettingsRow
        label="Bot response sound"
        description="Short message cue while FreeLM is in front; a distinct chime in the background. Mute and volume apply to both. Background notifications must also be on."
      >
        <Switch
          aria-label="Bot response sound"
          checked={!value.muted}
          disabled={disabled}
          onChange={(enabled) => onChange({ ...value, muted: !enabled })}
        />
      </SettingsRow>
      <SettingsRow
        label="Sound volume"
        description="Preview plays only when you choose it. Bot notification banners stay silent to avoid a second sound."
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input
            aria-label="Bot response volume"
            type="range"
            min="0"
            max="100"
            step="5"
            value={Math.round(value.volume * 100)}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, volume: Number(e.target.value) / 100 })}
          />
          <span>{Math.round(value.volume * 100)}%</span>
          <button
            type="button"
            className="secondary-button compact"
            disabled={previewing || value.volume === 0}
            onClick={async () => {
              setPreviewing(true);
              setError('');
              try {
                await playBotResponseSound(value.volume);
              } catch {
                setError('The chime could not play. Check your audio output and try again.');
              } finally {
                setPreviewing(false);
              }
            }}
          >
            Preview background chime
          </button>
          <button
            type="button"
            className="secondary-button compact"
            disabled={previewing || value.volume === 0}
            onClick={() => {
              void playBotResponseSound(value.volume, 'message').catch(() =>
                setError('The message cue could not play. Check your audio output.'),
              );
            }}
          >
            Preview message sound
          </button>
        </div>
      </SettingsRow>
      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
