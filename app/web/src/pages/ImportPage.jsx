import React, { useState } from 'react';
import {
  Card, Upload, Input, Button, Space, Typography, Table, Tag, Alert, App as AntApp,
} from 'antd';
import { InboxOutlined, EyeOutlined, CheckOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';

const STATUS_COLOR = {
  create: 'success', update: 'processing', unchanged: 'default', 'skip-manual': 'warning', invalid: 'error',
};

export default function ImportPage() {
  const { t } = useTranslation();
  const { api, refresh } = useAppData();
  const { message } = AntApp.useApp();
  const [csv, setCsv] = useState('');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (apply) => {
    if (!csv.trim()) return;
    setBusy(true);
    try {
      const r = await api.importCsv(csv, apply);
      if (r.error) { message.error(r.error); return; }
      setPlan(r);
      if (apply) { await refresh(); message.success(t('msg.done')); }
    } catch (e) {
      message.error(e.message || String(e));
    } finally { setBusy(false); }
  };

  const columns = [
    { title: t('import.col.domain'), dataIndex: 'domain', key: 'domain', render: (d) => <Typography.Text code>{d}</Typography.Text> },
    {
      title: t('import.col.status'), dataIndex: 'status', key: 'status', width: 140,
      render: (s) => <Tag color={STATUS_COLOR[s] || 'default'} bordered={false}>{s}</Tag>,
    },
    { title: t('import.col.detail'), dataIndex: 'detail', key: 'detail', render: (d) => <Typography.Text type="secondary">{d}</Typography.Text> },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card variant="borderless" title={t('import.title')}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('import.intro')}</Typography.Text>

          <Upload.Dragger
            accept=".csv,text/csv"
            multiple={false}
            showUploadList={false}
            beforeUpload={async (file) => { setCsv(await file.text()); return false; }}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">{t('import.dropTitle')}</p>
            <p className="ant-upload-hint" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{t('import.dropHint')}</p>
          </Upload.Dragger>

          <div>
            <Typography.Text type="secondary">{t('import.pasteLabel')}</Typography.Text>
            <Input.TextArea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={6}
              spellCheck={false}
              style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 13, marginTop: 6 }}
              placeholder={'"www.example.com","10.0.0.1","80","10.0.1.1","80"\n"www.example.com/api/*","10.0.0.5","8080","10.0.1.5","8080"'}
            />
          </div>

          <Space>
            <Button icon={<EyeOutlined />} loading={busy} disabled={!csv.trim()} onClick={() => run(false)}>{t('import.preview')}</Button>
            <Button type="primary" icon={<CheckOutlined />} loading={busy} disabled={!csv.trim()} onClick={() => run(true)}>{t('import.apply')}</Button>
          </Space>
        </Space>
      </Card>

      {plan && (
        <Card variant="borderless">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <Tag color={plan.applied ? 'success' : 'default'} bordered={false}>
                {plan.applied ? t('import.appliedTag') : t('import.previewTag')}
              </Tag>
              {plan.summary && (
                <Typography.Text type="secondary">
                  {t('import.summary', {
                    create: plan.summary.create, update: plan.summary.update,
                    unchanged: plan.summary.unchanged, manual: plan.summary['skip-manual'], invalid: plan.summary.invalid,
                  })}
                </Typography.Text>
              )}
            </Space>
            <Table
              size="small"
              rowKey={(_, i) => i}
              columns={columns}
              dataSource={plan.plan}
              pagination={plan.plan.length > 20 ? { pageSize: 20 } : false}
            />
            {plan.errors && plan.errors.length > 0 && (
              <Alert type="warning" showIcon message={`${plan.errors.length} invalid row(s) skipped`} />
            )}
          </Space>
        </Card>
      )}
    </Space>
  );
}
