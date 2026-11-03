import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import WelcomeOnboarding from '../components/WelcomeOnboarding';
const meta = {title: 'Onboarding/Welcome', component: WelcomeOnboarding, parameters: {layout: 'fullscreen'}} satisfies Meta<typeof WelcomeOnboarding>;
export default meta;
export const Welcome: StoryObj = {render: () => {
 const [open, setOpen] = useState(true);
 return <><button onClick={() => setOpen(true)}>Reopen setup</button><WelcomeOnboarding open={open} discoverModels={async () => ['synthetic-model']} secureStorage={false} onClose={() => setOpen(false)} onSave={async () => {throw new Error('Synthetic preview: no connection is saved.');}} /></>;
}};
