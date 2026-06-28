import React, { useMemo, useState } from 'react';
import {
  Layout, Menu, Typography, Button, Tooltip, Dropdown, Badge, Space, Grid, App as AntApp,
} from 'antd';
import {
  DashboardOutlined, ClusterOutlined, UploadOutlined, HistoryOutlined, FileTextOutlined,
  ReloadOutlined, BulbOutlined, BulbFilled, GlobalOutlined, ThunderboltOutlined, MenuOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from './theme/ThemeProvider.jsx';
import { useAppData } from './api/AppData.jsx';
import { LANGUAGES } from './i18n/index.js';

import Dashboard from './pages/Dashboard.jsx';
import Hosts from './pages/Hosts.jsx';
import ImportPage from './pages/ImportPage.jsx';
import History from './pages/History.jsx';
import Files from './pages/Files.jsx';
import StatusBanners from './components/StatusBanners.jsx';

const { Header, Sider, Content } = Layout;
const { useBreakpoint } = Grid;

function LiveIndicator() {
  const { t } = useTranslation();
  const { metrics } = useAppData();
  const down = !metrics || metrics.ok === false || metrics.active == null;
  const tip = down
    ? t('dashboard.offline')
    : `${t('dashboard.requestsWindow', { n: metrics.requestsWindow, sec: metrics.windowSec })} · ${t('dashboard.connections', { active: metrics.active })}`;
  return (
    <Tooltip title={tip}>
      <Space size={6} style={{ cursor: 'default' }}>
        <Badge status={down ? 'error' : 'processing'} />
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {down ? t('header.offline') : t('dashboard.perSec', { n: metrics.perSec })}
        </Typography.Text>
      </Space>
    </Tooltip>
  );
}

export default function App() {
  const { t, i18n } = useTranslation();
  const { dark, toggle } = useTheme();
  const { status, busy, editorEnabled, brand, run, api } = useAppData();
  const { notification } = AntApp.useApp();
  const screens = useBreakpoint();
  const [page, setPage] = useState('dashboard');
  const [collapsed, setCollapsed] = useState(false);
  const [testing, setTesting] = useState(false);

  async function testConfig() {
    setTesting(true);
    try {
      const r = await api.configTest();
      const common = { message: t('status.testLabel'), placement: 'bottomRight' };
      if (r.ok === true) notification.success({ ...common, description: `${t('status.testValid')} ✓` });
      else if (r.ok === null) notification.info({ ...common, description: r.message });
      else notification.error({
        ...common,
        message: `${t('status.testLabel')} — ${t('status.testFailed')}`,
        description: <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{r.message}</pre>,
        duration: 0,
      });
    } catch (e) {
      notification.error({ message: t('status.testLabel'), description: e.message || String(e), placement: 'bottomRight' });
    } finally { setTesting(false); }
  }

  const pending = !!status?.pending;
  const isMobile = !screens.md;

  const menuItems = useMemo(() => {
    const items = [
      { key: 'dashboard', icon: <DashboardOutlined />, label: t('nav.dashboard') },
      { key: 'hosts', icon: <ClusterOutlined />, label: t('nav.hosts') },
      { key: 'import', icon: <UploadOutlined />, label: t('nav.import') },
      { key: 'history', icon: <HistoryOutlined />, label: t('nav.history') },
    ];
    if (editorEnabled) items.push({ key: 'files', icon: <FileTextOutlined />, label: t('nav.files') });
    return items;
  }, [t, editorEnabled]);

  const pages = {
    dashboard: <Dashboard onNavigate={setPage} />,
    hosts: <Hosts />,
    import: <ImportPage />,
    history: <History />,
    files: <Files />,
  };

  const langMenu = {
    items: LANGUAGES.map((l) => ({ key: l.code, label: l.label })),
    selectable: true,
    selectedKeys: [i18n.language],
    onClick: ({ key }) => i18n.changeLanguage(key),
  };
  const currentLang = LANGUAGES.find((l) => l.code === i18n.language) || LANGUAGES[0];

  const sider = (
    <>
      <div style={{
        height: 56, display: 'flex', alignItems: 'center', gap: 10,
        padding: collapsed ? '0 0 0 22px' : '0 20px', overflow: 'hidden', whiteSpace: 'nowrap',
      }}>
        <ThunderboltOutlined style={{ fontSize: 22, color: '#3b82f6' }} />
        {!collapsed && (
          <div style={{ lineHeight: 1.15 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{brand}</div>
            <div style={{ fontSize: 11, opacity: 0.55 }}>{t('app.subtitle')}</div>
          </div>
        )}
      </div>
      <Menu
        theme={dark ? 'dark' : 'light'}
        mode="inline"
        selectedKeys={[page]}
        items={menuItems}
        onClick={({ key }) => { setPage(key); if (isMobile) setCollapsed(true); }}
        style={{ borderInlineEnd: 0, background: 'transparent' }}
      />
    </>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {!isMobile && (
        <Sider
          theme={dark ? 'dark' : 'light'}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          width={232}
          style={{ borderInlineEnd: `1px solid ${dark ? '#20242e' : '#e8e8e8'}` }}
        >
          {sider}
        </Sider>
      )}

      <Layout>
        <Header style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px',
          borderBottom: `1px solid ${dark ? '#20242e' : '#e8e8e8'}`, position: 'sticky', top: 0, zIndex: 10,
        }}>
          {isMobile && (
            <Button type="text" icon={<MenuOutlined />} onClick={() => setCollapsed((c) => !c)} />
          )}
          <Typography.Text strong style={{ fontSize: 15 }}>
            {menuItems.find((m) => m.key === page)?.label}
          </Typography.Text>

          <div style={{ flex: 1 }} />

          <LiveIndicator />

          <Tooltip title={t('header.testConfig')}>
            <Button icon={<ExperimentOutlined />} loading={testing} onClick={testConfig}>
              {!isMobile && t('header.testConfig')}
            </Button>
          </Tooltip>

          <Tooltip title={pending ? t('header.pendingTip') : t('header.nothingPending')}>
            <Badge dot={pending} color="#f59e0b" offset={[-2, 2]}>
              <Button
                type={pending ? 'primary' : 'default'}
                icon={<ReloadOutlined />}
                loading={busy}
                onClick={() => run(api.reload)}
              >
                {!isMobile && t('header.reload')}
              </Button>
            </Badge>
          </Tooltip>

          <Dropdown menu={langMenu} trigger={['click']}>
            <Button type="text" icon={<GlobalOutlined />}>{currentLang.short}</Button>
          </Dropdown>

          <Tooltip title={t('header.theme')}>
            <Button type="text" icon={dark ? <BulbFilled /> : <BulbOutlined />} onClick={toggle} />
          </Tooltip>
        </Header>

        <Content style={{ padding: isMobile ? 12 : 24, overflow: 'auto' }}>
          <div style={{ maxWidth: 1280, margin: '0 auto' }}>
            <StatusBanners onNavigate={setPage} />
            {pages[page]}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
