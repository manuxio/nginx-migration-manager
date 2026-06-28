import React from 'react';
import { createRoot } from 'react-dom/client';
import './i18n/index.js';
import './styles.css';
import ThemeProvider from './theme/ThemeProvider.jsx';
import AppDataProvider from './api/AppData.jsx';
import HostEditorProvider from './modals/HostEditorProvider.jsx';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppDataProvider>
        <HostEditorProvider>
          <App />
        </HostEditorProvider>
      </AppDataProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
