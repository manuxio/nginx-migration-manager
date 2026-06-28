import React, { useMemo, useState } from 'react';
import {
  Row, Col, Card, Statistic, Progress, Button, Space, Alert, Typography, Empty, Tag,
} from 'antd';
import {
  ApartmentOutlined, CheckCircleOutlined, SwapOutlined, StopOutlined, ThunderboltOutlined,
  ReloadOutlined, ExperimentOutlined, ArrowRightOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';

const A = '#22c55e';
const B = '#f59e0b';

export default function Dashboard({ onNavigate }) {
  const { t } = useTranslation();
  const { hosts, status, metrics, busy, run, api, loaded } = useAppData();
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const s = useMemo(() => {
    let onA = 0, onB = 0, disabled = 0, migratable = 0, onBall = 0, total = 0;
    for (const h of hosts) for (const r of h.routes) {
      total++;
      if (r.active === 'alt') onBall++;
      if (!h.enabled) { disabled++; continue; }
      if (r.active === 'alt') onB++; else onA++;
      if (r.alt) migratable++;
    }
    const pct = migratable ? Math.round((onBall / migratable) * 100) : 0;
    const disabledHosts = hosts.filter((h) => !h.enabled).length;
    return { total, hostsN: hosts.length, onA, onB, disabled, migratable, pct, disabledHosts };
  }, [hosts]);

  const netDown = !metrics || metrics.ok === false || metrics.active == null;

  async function testConfig() {
    setTesting(true);
    try { setTestResult(await api.configTest()); }
    catch (e) { setTestResult({ ok: false, message: e.message || String(e) }); }
    finally { setTesting(false); }
  }

  const statCard = (title, value, opts = {}) => (
    <Card variant="borderless" styles={{ body: { padding: 20 } }}>
      <Statistic
        title={<Space>{opts.icon}{title}</Space>}
        value={value}
        valueStyle={{ color: opts.color, fontWeight: 600 }}
        suffix={opts.suffix}
      />
      {opts.foot && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{opts.foot}</Typography.Text>}
    </Card>
  );

  if (loaded && hosts.length === 0) {
    return (
      <Card variant="borderless">
        <Empty description={t('dashboard.noData')}>
          <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => onNavigate('import')}>{t('nav.import')}</Button>
        </Empty>
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={12} md={8} lg={6} xl={5}>
          {statCard(t('dashboard.routes'), s.total, {
            icon: <ApartmentOutlined />, foot: t('dashboard.ofHosts', { count: s.hostsN }),
          })}
        </Col>
        <Col xs={12} sm={12} md={8} lg={6} xl={5}>
          {statCard(t('dashboard.onA'), s.onA, { icon: <CheckCircleOutlined style={{ color: A }} />, color: A })}
        </Col>
        <Col xs={12} sm={12} md={8} lg={6} xl={5}>
          {statCard(t('dashboard.onB'), s.onB, {
            icon: <SwapOutlined style={{ color: B }} />, color: B, foot: t('dashboard.onBMigrated'),
          })}
        </Col>
        <Col xs={12} sm={12} md={8} lg={6} xl={4}>
          {statCard(t('dashboard.disabled'), s.disabledHosts, {
            icon: <StopOutlined />, foot: t('dashboard.disabledHosts'),
          })}
        </Col>
        <Col xs={24} sm={12} md={8} lg={12} xl={5}>
          <Card variant="borderless" styles={{ body: { padding: 20 } }}>
            <Statistic
              title={<Space><ThunderboltOutlined style={{ color: netDown ? '#ef4444' : A }} />{t('dashboard.throughput')}</Space>}
              value={netDown ? t('header.offline') : metrics.perSec}
              suffix={netDown ? undefined : 'req/s'}
              valueStyle={{ color: netDown ? '#ef4444' : undefined, fontWeight: 600 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {netDown ? t('dashboard.offline') : t('dashboard.connections', { active: metrics.active })}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card variant="borderless" title={t('dashboard.migrationProgress')} style={{ height: '100%' }}>
            <Progress
              percent={s.pct}
              strokeColor={{ '0%': '#3b82f6', '100%': B }}
              status="active"
            />
            <Typography.Text type="secondary">
              {t('dashboard.migratedOf', { pct: s.pct, count: s.migratable })}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card variant="borderless" title={t('dashboard.quickActions')} style={{ height: '100%' }}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Space wrap>
                <Button icon={<ExperimentOutlined />} loading={testing} onClick={testConfig}>{t('header.testConfig')}</Button>
                <Button
                  type={status?.pending ? 'primary' : 'default'}
                  icon={<ReloadOutlined />} loading={busy} onClick={() => run(api.reload)}
                >
                  {t('header.reload')}
                </Button>
              </Space>
              {testResult && (
                <Alert
                  type={testResult.ok === true ? 'success' : testResult.ok === null ? 'info' : 'error'}
                  showIcon
                  message={<Space>
                    <b>{t('status.testLabel')}:</b>
                    {testResult.ok === true ? <Tag color="success">{t('status.testValid')} ✓</Tag>
                      : testResult.ok === null ? <Tag>{t('status.testUnknown')}</Tag>
                        : <Tag color="error">{t('status.testFailed')} ✗</Tag>}
                  </Space>}
                  description={testResult.message
                    ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{testResult.message}</pre> : null}
                />
              )}
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
