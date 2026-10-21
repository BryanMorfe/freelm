import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './components/sidebar.css';
import { installWorkspaceDesktopBridge } from './lib/desktop-workspace';

installWorkspaceDesktopBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
