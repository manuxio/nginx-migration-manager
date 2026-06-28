// Thin wrapper over CodeMirror: picks nginx/html/plain syntax from the file name and follows
// the app's dark/light theme. Used by both the per-host editor modal and the raw file editor.
import React, { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { html } from '@codemirror/lang-html';
import { useTheme } from '../theme/ThemeProvider.jsx';

// nginx for *.conf / nginx.conf / mime.types / extensionless, html for *.htm(l), plain otherwise.
const langFor = (name = '') =>
  /\.html?$/i.test(name) ? [html()]
    : (/\.(conf|types)$/i.test(name) || /(^|\/)nginx\.conf$/i.test(name) || !/\.[a-z0-9]+$/i.test(name))
      ? [StreamLanguage.define(nginx)]
      : [];

export default function CodeEditor({ value, onChange, name = '', height = '420px', readOnly = false }) {
  const { dark } = useTheme();
  const extensions = useMemo(() => langFor(name), [name]);
  return (
    <CodeMirror
      value={value}
      height={height}
      theme={dark ? 'dark' : 'light'}
      editable={!readOnly}
      readOnly={readOnly}
      extensions={extensions}
      basicSetup={{ lineNumbers: true, highlightActiveLine: !readOnly, foldGutter: false }}
      onChange={onChange}
      style={{ fontSize: 13, borderRadius: 8, overflow: 'hidden', border: `1px solid ${dark ? '#262b36' : '#e8e8e8'}` }}
    />
  );
}
