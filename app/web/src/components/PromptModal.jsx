// Small single-input modal used for "Add host" and "Add path". onSubmit(value) returns the
// API result; a returned { error } keeps the modal open and shows the message inline (so the
// user can fix the value), anything else closes it. Enter submits.
import React, { useEffect, useState } from 'react';
import { Modal, Input, Form, Alert, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

export default function PromptModal({ open, title, placeholder, hint, okText, onCancel, onSubmit }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { if (open) { setValue(''); setError(null); setBusy(false); } }, [open]);

  const submit = async () => {
    const v = value.trim();
    if (!v) { onCancel(); return; }
    setBusy(true); setError(null);
    try {
      const r = await onSubmit(v);
      if (r && r.error) { setError(r.error); return; }
      onCancel();
    } catch (e) {
      setError(e.message || String(e));
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={open}
      title={title}
      okText={okText || t('common.add')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      onOk={submit}
      onCancel={onCancel}
      destroyOnClose
    >
      <Form layout="vertical" onSubmitCapture={(e) => { e.preventDefault(); submit(); }}>
        <Form.Item style={{ marginBottom: hint ? 8 : 0 }}>
          <Input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onPressEnter={submit}
          />
        </Form.Item>
        {hint && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>}
        {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} />}
      </Form>
    </Modal>
  );
}
