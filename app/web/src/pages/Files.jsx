import React, { useCallback, useEffect, useState } from 'react';
import {
  Card, Row, Col, List, Button, Alert, Typography, Tag, Space, Breadcrumb, Empty, App as AntApp,
} from 'antd';
import {
  FolderFilled, FileOutlined, ArrowUpOutlined, SaveOutlined, WarningOutlined, HomeOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';
import { fmtSize } from '../api/client.js';
import CodeEditor from '../components/CodeEditor.jsx';

export default function Files() {
  const { t } = useTranslation();
  const { api, editorEnabled } = useAppData();
  const { message } = AntApp.useApp();

  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState([]);
  const [file, setFile] = useState(null);   // { path, content?, size, binary?, tooLarge? }
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const loadDir = useCallback(async (p) => {
    try {
      const r = await api.files(p);
      if (r.error) { message.error(r.error); return; }
      setDir(r.path); setEntries(r.entries);
    } catch (e) { message.error(e.message || String(e)); }
  }, [api, message]);

  useEffect(() => { if (editorEnabled) loadDir(''); }, [editorEnabled, loadDir]);

  const openFile = async (p) => {
    setResult(null);
    try {
      const r = await api.file(p);
      if (r.error) { message.error(r.error); return; }
      setFile(r); setContent(r.content || ''); setDirty(false);
    } catch (e) { message.error(e.message || String(e)); }
  };

  const save = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await api.saveFile(file.path, content);
      setResult(r);
      if (!r.error) setDirty(false);
    } catch (e) { setResult({ error: e.message || String(e) }); }
    finally { setBusy(false); }
  };

  if (!editorEnabled) return <Card variant="borderless"><Alert type="info" showIcon message={t('files.disabled')} /></Card>;

  const childOf = (e) => (dir ? `${dir}/${e.name}` : e.name);
  const up = dir ? dir.split('/').slice(0, -1).join('/') : null;
  const segments = dir ? dir.split('/') : [];

  return (
    <Card
      variant="borderless"
      title={
        <Space wrap>
          {t('files.title')}
          <Tag icon={<WarningOutlined />} color="warning" bordered={false}>{t('files.warn')}</Tag>
        </Space>
      }
    >
      <Row gutter={16}>
        <Col xs={24} md={8} lg={7}>
          <Breadcrumb
            style={{ marginBottom: 8 }}
            items={[
              { title: <a onClick={() => loadDir('')}><HomeOutlined /> {t('files.root')}</a> },
              ...segments.map((seg, i) => ({
                title: <a onClick={() => loadDir(segments.slice(0, i + 1).join('/'))}>{seg}</a>,
              })),
            ]}
          />
          <div style={{ maxHeight: '62vh', overflow: 'auto', border: '1px solid rgba(128,137,158,0.22)', borderRadius: 8 }}>
            <List
              size="small"
              dataSource={[...(up !== null ? [{ name: '..', dir: true, up: true }] : []), ...entries]}
              renderItem={(e) => {
                const active = file && !e.dir && file.path === childOf(e);
                return (
                  <List.Item
                    style={{ cursor: 'pointer', padding: '6px 12px', background: active ? 'rgba(128,137,158,0.16)' : undefined }}
                    onClick={() => (e.up ? loadDir(up) : e.dir ? loadDir(childOf(e)) : openFile(childOf(e)))}
                  >
                    <Space>
                      {e.dir ? (e.up ? <ArrowUpOutlined /> : <FolderFilled style={{ color: '#f6c453' }} />) : <FileOutlined />}
                      <Typography.Text strong={active}>{e.name}</Typography.Text>
                    </Space>
                    {!e.dir && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{fmtSize(e.size)}</Typography.Text>}
                  </List.Item>
                );
              }}
            />
          </div>
        </Col>

        <Col xs={24} md={16} lg={17}>
          {!file && <Empty description={t('files.selectHint')} style={{ marginTop: 80 }} />}
          {file && file.tooLarge && <Alert type="warning" showIcon message={t('files.tooLarge', { size: fmtSize(file.size) })} />}
          {file && file.binary && <Alert type="warning" showIcon message={t('files.binary')} />}
          {file && file.content != null && (
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Typography.Text code>{file.path}</Typography.Text>
                {dirty && <Tag color="warning" bordered={false}>● {t('files.unsaved')}</Tag>}
                <Button type="primary" size="small" icon={<SaveOutlined />} style={{ marginInlineStart: 'auto' }} loading={busy} disabled={!dirty} onClick={save}>{t('files.save')}</Button>
              </div>
              <CodeEditor value={content} name={file.path} height="56vh" onChange={(v) => { setContent(v); setDirty(true); }} />
              {result && (result.error
                ? <Alert type="error" showIcon message={result.error} />
                : <Alert
                    type={result.ok ? 'success' : result.ok === null ? 'info' : 'warning'}
                    showIcon
                    message={<Space><b>{t('status.testLabel')}:</b>
                      {result.ok === true ? <span>{t('files.testValid')}</span>
                        : result.ok === null ? <span>{t('files.testUnknown')}</span>
                          : <Tag color="error">{t('status.testFailed')} ✗</Tag>}
                    </Space>}
                    description={result.ok === false && result.message ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{result.message}</pre> : null}
                  />)}
            </Space>
          )}
        </Col>
      </Row>
    </Card>
  );
}
