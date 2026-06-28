import React, { useMemo } from 'react';
import {
  Card, Table, Tag, Button, Typography, Space, Popconfirm, App as AntApp,
} from 'antd';
import { RollbackOutlined, PlayCircleFilled } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';

export default function History() {
  const { t } = useTranslation();
  const { hist, served, busy, run, api } = useAppData();
  const { message } = AntApp.useApp();

  const runningIndex = useMemo(
    () => hist.findIndex((c) => served && (c.hash.startsWith(served) || served.startsWith(c.hash))),
    [hist, served],
  );

  const rollback = (c) => run(async () => {
    const r = await api.rollback(c.hash);
    if (r && r.error) message.error(`${t('msg.rollbackFailed')}: ${r.error}`);
  });

  const columns = [
    {
      title: t('history.col.commit'), dataIndex: 'hash', key: 'hash', width: 220,
      render: (hash, _r, i) => (
        <Space size={6} wrap>
          <Typography.Text code copyable={{ text: hash }}>{hash}</Typography.Text>
          {i === 0 && <Tag bordered={false}>{t('history.latest')}</Tag>}
          {i === runningIndex && <Tag icon={<PlayCircleFilled />} color="success" bordered={false}>{t('history.running')}</Tag>}
          {runningIndex >= 0 && i < runningIndex && <Tag color="warning" bordered={false}>{t('history.pending')}</Tag>}
        </Space>
      ),
    },
    { title: t('history.col.timestamp'), dataIndex: 'date', key: 'date', width: 200, render: (d) => <Typography.Text type="secondary">{d}</Typography.Text> },
    { title: t('history.col.change'), dataIndex: 'message', key: 'message' },
    {
      title: t('history.col.action'), key: 'action', width: 130, align: 'right',
      render: (_, c, i) => (
        <Popconfirm
          title={t('history.confirmRollback', { hash: c.hash })}
          okText={t('history.rollback')} okType="danger" cancelText={t('common.cancel')}
          disabled={i === 0}
          onConfirm={() => rollback(c)}
        >
          <Button size="small" icon={<RollbackOutlined />} disabled={busy || i === 0}>{t('history.rollback')}</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <Card variant="borderless" title={t('history.title')}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t('history.intro')}
          <br />
          <Tag icon={<PlayCircleFilled />} color="success" bordered={false}>{t('history.running')}</Tag> {t('history.legendRunning')}{' '}
          <Tag color="warning" bordered={false}>{t('history.pending')}</Tag> {t('history.legendPending')}
        </Typography.Paragraph>
        <Table
          size="middle"
          rowKey="hash"
          columns={columns}
          dataSource={hist}
          pagination={hist.length > 25 ? { pageSize: 25 } : false}
          rowClassName={(_, i) => (i === runningIndex ? 'commit-running' : '')}
          locale={{ emptyText: t('history.empty') }}
        />
      </Space>
    </Card>
  );
}
