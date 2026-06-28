// Cross-page alerts shown above every page's content: a dismissable global error, an nginx
// reload-failure banner, and the "changes pending — reload" banner (with its config-test
// verdict). Each offers an "Edit <broken>.conf" shortcut into the shared host editor when the
// failing file can be parsed out of nginx's message.
import React from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';
import { useHostEditor } from '../modals/HostEditorProvider.jsx';

const brokenDomain = (msg) => {
  const m = /\/sites\/([A-Za-z0-9._-]+?)\.conf(?:\.disabled)?\b/.exec(msg || '');
  return m ? m[1] : null;
};

export default function StatusBanners() {
  const { t } = useTranslation();
  const { status, error, setError } = useAppData();
  const { openHostEditor } = useHostEditor();

  const editBtn = (msg) => {
    const d = brokenDomain(msg);
    return d ? <Button size="small" onClick={() => openHostEditor(d)}>{t('status.editConf', { name: d })}</Button> : null;
  };

  const banners = [];

  if (error) {
    banners.push(
      <Alert
        key="err" type="error" showIcon closable onClose={() => setError(null)}
        message={<span style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{error}</span>}
      />,
    );
  }

  if (status && status.reload.known && !status.reload.ok) {
    banners.push(
      <Alert
        key="reload" type="error" showIcon
        message={<b>{t('status.reloadProblem')}</b>}
        description={<Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{status.reload.message}</Typography.Text>
          {editBtn(status.reload.message)}
        </Space>}
      />,
    );
  }

  if (status && status.pending) {
    const ok = status.test.ok;
    banners.push(
      <Alert
        key="pending" type={ok ? 'warning' : 'error'} showIcon
        message={<b>{t('status.pendingTitle')}</b>}
        description={<Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Typography.Text>
            <b>{t('status.testLabel')}:</b> {ok ? t('status.pendingValid') : t('status.pendingFailed')}
          </Typography.Text>
          {!ok && status.test.message && (
            <Typography.Text style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{status.test.message}</Typography.Text>
          )}
          {!ok && editBtn(status.test.message)}
        </Space>}
      />,
    );
  }

  if (!banners.length) return null;
  return <Space direction="vertical" size={12} style={{ width: '100%', marginBottom: 16 }}>{banners}</Space>;
}
