import { describe, expect, it } from 'vitest';
import { assertToolSettingsValues } from '../src/components/ToolSettings';
import { defaultToolSettings } from '../src/lib/tool-settings';
import { initialState } from '../src/lib/state';

describe('Code permission settings validation', () => {
	it('allows enabled command execution without a global working directory', () => {
		const settings = {
			...defaultToolSettings(),
			enabled: true,
			commandExecution: true,
			workspaceRoot: '',
		};
		expect(() => assertToolSettingsValues(settings, initialState().connections)).not.toThrow();
	});
	it('keeps explicit disabled settings unchanged and accepts legacy permission modes', () => {
		const settings = { ...defaultToolSettings(), enabled: false, commandExecution: false };
		const before = structuredClone(settings);
		assertToolSettingsValues(settings, initialState().connections);
		expect(settings).toEqual(before);
		for (const approvalMode of ['ask', 'auto-review', 'full-access', 'trusted'] as const)
			expect(() =>
				assertToolSettingsValues({ ...settings, approvalMode }, initialState().connections),
			).not.toThrow();
	});
	it('rejects unsupported permissions and supplied non-absolute working directories', () => {
		const settings = defaultToolSettings();
		for (const workspaceRoot of ['relative/path', ' /absolute/path'])
			expect(() =>
				assertToolSettingsValues({ ...settings, workspaceRoot }, initialState().connections),
			).toThrow('absolute working directory');
		expect(() =>
			assertToolSettingsValues(
				{ ...settings, approvalMode: 'anything' } as never,
				initialState().connections,
			),
		).toThrow('Code permission mode');
	});
	it('still requires an image connection and model independently of Code permissions', () => {
		const state = initialState();
		const settings = defaultToolSettings();
		settings.imageGeneration.enabled = true;
		expect(() => assertToolSettingsValues(settings, state.connections)).toThrow('API connection');
		settings.imageGeneration.connectionId = state.activeConnectionId;
		expect(() => assertToolSettingsValues(settings, state.connections)).toThrow(
			'image generation model',
		);
	});
	it('requires a video connection and model only when video generation is enabled', () => {
		const state = initialState();
		const settings = defaultToolSettings();
		assertToolSettingsValues(settings, state.connections);
		settings.videoGeneration!.enabled = true;
		expect(() => assertToolSettingsValues(settings, state.connections)).toThrow(
			'API connection for video generation',
		);
		settings.videoGeneration!.connectionId = state.activeConnectionId;
		expect(() => assertToolSettingsValues(settings, state.connections)).toThrow(
			'video generation model',
		);
		settings.videoGeneration!.model = 'video-model';
		expect(() => assertToolSettingsValues(settings, state.connections)).not.toThrow();
		settings.videoGeneration!.size = 'landscape';
		expect(() => assertToolSettingsValues(settings, state.connections)).toThrow('Video size');
		settings.videoGeneration!.size = '1920x1080';
		settings.videoGeneration!.seconds = '-1';
		expect(() => assertToolSettingsValues(settings, state.connections)).toThrow('Video duration');
		settings.videoGeneration!.seconds = '15';
		expect(() => assertToolSettingsValues(settings, state.connections)).not.toThrow();
	});
});
