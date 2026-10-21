import { addons } from 'storybook/manager-api';
import { create } from 'storybook/theming';

addons.setConfig({
	theme: create({ base: 'dark', brandTitle: 'FreeLM · Components' }),
	layout: { showPanel: true, panelPosition: 'bottom' },
});
