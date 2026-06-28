// Shared "peek / edit one host's .conf" modal, exposed app-wide via openHostEditor(domain) so
// both the Hosts table and the status banners (Edit <broken>.conf) can open it. Saving writes
// the file, commits a checkpoint and runs nginx -t — the change is pending until a reload.
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Modal, Button, Space, Tag, Alert, Typography, App as AntApp } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';
import CodeEditor from '../components/CodeEditor.jsx';

const HostEditorContext = createContext({ openHostEditor: () => {} });
export const useHostEditor = () => useContext(HostEditorContext);

export default function HostEditorProvider({ children }) {
  const { t } = useTranslation();
  const { api, refresh } = useAppData();
  const { message, modal } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState(null);
  const [content, setContent] = useState('');
  const [saveMsg, setSaveMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const openHostEditor = useCallback(async (domain) => {
    setBusy(true);
    try {
      const p = await api.host(domain);
      if (p.error) { message.error(p.error); return; }
      setPeek(p); setContent(p.content || ''); setSaveMsg(null); setOpen(true);
    } catch (e) {
      message.error(e.message || String(e));
    } finally { setBusy(false); }
  }, [api, message]);

  const dirty = peek && content !== peek.content;

  const close = () => {
    if (dirty) {
      modal.confirm({ title: t('editor.discard'), okText: t('common.yes'), cancelText: t('common.no'), onOk: () => setOpen(false) });
    } else setOpen(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveHost(peek.domain, content);
      setSaveMsg(r);
      if (!r.error) { setPeek({ ...peek, content }); await refresh(); }
    } catch (e) {
      setSaveMsg({ error: e.message || String(e) });
    } finally { setBusy(false); }
  };

  const ctx = useMemo(() => ({ openHostEditor }), [openHostEditor]);

  const testTag = saveMsg && !saveMsg.error && (
    saveMsg.ok === true ? <Tag color="success">{t('status.testValid')} ✓</Tag>
      : saveMsg.ok === null ? <Tag>{t('status.testUnknown')}</Tag>
        : <Tag color="error">{t('status.testFailed')} ✗</Tag>
  );

  return (
    <HostEditorContext.Provider value={ctx}>
      {children}
      <Modal
        open={open}
        onCancel={close}
        width={920}
        title={peek ? <Typography.Text code>{peek.file}</Typography.Text> : ''}
        footer={[
          <Button key="dl" icon={<DownloadOutlined />} href={peek ? `/api/download?domain=${encodeURIComponent(peek.domain)}` : undefined}>
            {t('common.download')}
          </Button>,
          <Button key="close" onClick={close}>{t('common.close')}</Button>,
          <Button key="save" type="primary" loading={busy} disabled={!dirty} onClick={save}>
            {t('editor.saveCommit')}
          </Button>,
        ]}
      >
        {peek && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap size={[4, 4]}>
              <Typography.Text type="secondary">{t('editor.routes', { count: (peek.routes || []).length })}:</Typography.Text>
              {(peek.routes || []).map((r) => <Tag key={r.path} bordered={false}>{r.path}</Tag>)}
            </Space>
            <CodeEditor value={content} name={peek.file} height="50vh" onChange={setContent} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('editor.saveHint')}</Typography.Text>
            {saveMsg && (saveMsg.error
              ? <Alert type="error" showIcon message={saveMsg.error} />
              : <Alert
                  type={saveMsg.ok ? 'warning' : 'error'}
                  showIcon
                  message={<Space>{t('editor.saved')} {testTag}</Space>}
                  description={saveMsg.message ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{saveMsg.message}</pre> : null}
                />)}
          </Space>
        )}
      </Modal>
    </HostEditorContext.Provider>
  );
}
