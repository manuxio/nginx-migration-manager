// Inline click-to-edit value used for host names, route paths and backend cells. Shows the
// value (styled by the caller) with a pencil that appears on hover when editable; clicking the
// pencil — or double-clicking the value — swaps in an Input. Enter / blur commit, Esc cancels.
// onSubmit receives the trimmed new value; the caller decides whether it changed enough to act.
import React, { useEffect, useRef, useState } from 'react';
import { Input, Tooltip } from 'antd';
import { EditOutlined } from '@ant-design/icons';

export default function EditableText({
  value, onSubmit, editable = true, placeholder, tooltip, display, width = 160, mono = true,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const ref = useRef(null);
  const committed = useRef(false);

  useEffect(() => { if (editing) setDraft(value ?? ''); }, [editing, value]);

  const start = () => { if (editable) { committed.current = false; setEditing(true); } };
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    setEditing(false);
    onSubmit((draft ?? '').trim());
  };
  const cancel = () => { committed.current = true; setEditing(false); };

  if (editing) {
    return (
      <Input
        ref={ref}
        size="small"
        autoFocus
        value={draft}
        placeholder={placeholder}
        style={{ width, fontFamily: mono ? 'ui-monospace, Menlo, Consolas, monospace' : undefined }}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={commit}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
      />
    );
  }

  const shown = display ?? (
    <span style={{ fontFamily: mono ? 'ui-monospace, Menlo, Consolas, monospace' : undefined }}>
      {value || '—'}
    </span>
  );

  return (
    <span
      className={editable ? 'editable' : undefined}
      onDoubleClick={start}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: editable ? 'text' : 'default' }}
    >
      {shown}
      {editable && (
        <Tooltip title={tooltip}>
          <EditOutlined
            className="editable-pencil"
            onClick={start}
            style={{ fontSize: 12, opacity: 0.45, cursor: 'pointer' }}
          />
        </Tooltip>
      )}
    </span>
  );
}
