// Per-host "which location wins?" tester. The user types a request path; the server runs
// nginx's real location-selection rules over the host's .conf and returns the winning block
// plus every candidate. We highlight the winner and show why it was chosen.
import React, { useEffect, useState } from 'react';
import { Modal, Input, Typography, Alert, Table, Tag, Space, App as AntApp } from 'antd';
import { AimOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';

const TYPE_COLOR = {
  exact: 'blue', prefix: 'default', prefixPriority: 'geekblue', regex: 'purple', iregex: 'purple',
};

export default function RouteTesterModal({ domain, open, onClose }) {
  const { t } = useTranslation();
  const { api } = useAppData();
  const { message } = AntApp.useApp();
  const [path, setPath] = useState('/');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setPath('/'); setResult(null); } }, [open, domain]);

  const run = async (value) => {
    setBusy(true);
    try {
      const r = await api.matchPath(domain, value || '/');
      if (r.error) { message.error(r.error); return; }
      setResult(r);
    } catch (e) { message.error(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const typeTag = (modifier) => (
    <Tag color={TYPE_COLOR[modifier]} bordered={false}>{t(`tester.type.${modifier}`)}</Tag>
  );

  const columns = [
    {
      title: t('tester.col.location'), dataIndex: 'directive', key: 'directive',
      render: (d, r) => (
        <Space size={6}>
          <Typography.Text code style={{ fontWeight: r.winner ? 700 : 400 }}>{d}</Typography.Text>
          {r.winner && <Tag color="success" bordered={false}>{t('tester.winner')}</Tag>}
        </Space>
      ),
    },
    { title: t('tester.col.type'), dataIndex: 'modifier', key: 'modifier', width: 110, render: typeTag },
    {
      title: t('tester.col.upstream'), dataIndex: 'upstream', key: 'upstream', width: 160,
      render: (u) => (u ? <Typography.Text code>{u}</Typography.Text> : <Typography.Text type="secondary">{t('tester.noMatchCell')}</Typography.Text>),
    },
    {
      title: t('tester.col.match'), dataIndex: 'matches', key: 'matches', width: 90, align: 'center',
      render: (m) => (m
        ? <Tag icon={<CheckOutlined />} color="green" bordered={false}>{t('tester.matches')}</Tag>
        : <CloseOutlined style={{ opacity: 0.3 }} />),
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      title={<Space><AimOutlined />{t('tester.title', { domain })}</Space>}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{t('tester.intro')}</Typography.Text>
        <Input.Search
          autoFocus
          value={path}
          placeholder={t('tester.placeholder')}
          enterButton={t('tester.run')}
          loading={busy}
          onChange={(e) => setPath(e.target.value)}
          onSearch={run}
          style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}
        />

        {result && (result.matched
          ? (
            <Alert
              type="success"
              showIcon
              message={(
                <Space wrap size={8}>
                  <span>{t('tester.matched')}:</span>
                  <Typography.Text code strong>{result.matched.directive}</Typography.Text>
                  {result.matched.upstream && <Tag bordered={false}>→ {result.matched.upstream}</Tag>}
                </Space>
              )}
              description={t(`tester.reason.${result.reason}`)}
            />
          )
          : <Alert type="warning" showIcon message={t('tester.noMatch')} />
        )}

        {result && (
          <Table
            size="small"
            rowKey={(_, i) => i}
            columns={columns}
            dataSource={result.candidates}
            pagination={false}
            rowClassName={(r) => (r.winner ? 'commit-running' : '')}
          />
        )}
      </Space>
    </Modal>
  );
}
