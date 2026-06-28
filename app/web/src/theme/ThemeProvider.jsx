// Wraps the app in antd's ConfigProvider: dark/light algorithm (dark by default, persisted in
// localStorage) + a small brand token override, and keeps antd's own locale in sync with i18n.
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ConfigProvider, theme as antdTheme, App as AntApp } from 'antd';
import enUS from 'antd/locale/en_US';
import itIT from 'antd/locale/it_IT';
import { useTranslation } from 'react-i18next';

const ThemeContext = createContext({ dark: true, toggle: () => {} });
export const useTheme = () => useContext(ThemeContext);

const ANTD_LOCALES = { en: enUS, it: itIT };

export default function ThemeProvider({ children }) {
  const { i18n } = useTranslation();
  const [dark, setDark] = useState(() => (localStorage.getItem('theme') || 'dark') !== 'light');

  useEffect(() => {
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.body.style.background = dark ? '#0f1115' : '#f0f2f5';
  }, [dark]);

  const ctx = useMemo(() => ({ dark, toggle: () => setDark((d) => !d) }), [dark]);

  const algorithm = dark
    ? [antdTheme.darkAlgorithm]
    : [antdTheme.defaultAlgorithm];

  return (
    <ThemeContext.Provider value={ctx}>
      <ConfigProvider
        locale={ANTD_LOCALES[i18n.language] || enUS}
        theme={{
          algorithm,
          cssVar: true,
          token: {
            colorPrimary: '#3b82f6',
            colorInfo: '#3b82f6',
            borderRadius: 8,
            fontFamily:
              "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          },
          components: {
            Layout: dark
              ? { siderBg: '#13161d', headerBg: '#13161d', bodyBg: '#0f1115' }
              : { siderBg: '#ffffff', headerBg: '#ffffff', bodyBg: '#f0f2f5' },
            Menu: dark ? { itemBg: 'transparent' } : undefined,
          },
        }}
      >
        <AntApp style={{ height: '100%' }}>{children}</AntApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
