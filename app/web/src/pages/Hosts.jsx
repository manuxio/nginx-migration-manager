import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card, Table, Input, Select, Segmented, Button, Space, Tag, Typography, Tooltip, Dropdown,
  Popconfirm, Modal, App as AntApp, Grid,
} from 'antd';
import {
  SearchOutlined, PlusOutlined, DownloadOutlined, ExportOutlined, MoreOutlined,
  EditOutlined, DeleteOutlined, EyeOutlined, FileAddOutlined, PoweroffOutlined, PlayCircleOutlined,
  AimOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../api/AppData.jsx';
import { useHostEditor } from '../modals/HostEditorProvider.jsx';
import EditableText from '../components/EditableText.jsx';
import PromptModal from '../components/PromptModal.jsx';
import RouteTesterModal from '../modals/RouteTesterModal.jsx';

const { useBreakpoint } = Grid;

export default function Hosts() {
  const { t } = useTranslation();
  const { hosts, busy, run, api } = useAppData();
  const { openHostEditor } = useHostEditor();
  const { message, modal } = AntApp.useApp();
  const screens = useBreakpoint();

  const [q, setQ] = useState('');
  const [field, setField] = useState('any');
  const [statusFilter, setStatusFilter] = useState('all');
  const [expanded, setExpanded] = useState([]);
  const [addHostOpen, setAddHostOpen] = useState(false);
  const [addPathFor, setAddPathFor] = useState(null); // host domain
  const [testerFor, setTesterFor] = useState(null);   // host domain

  const pathLabel = (p) => (p === '/' ? `/  (${t('common.wholeSite')})` : p);

  // run a mutating call and surface a returned {error} as a toast
  const act = (thunk, failKey) => run(async () => {
    const r = await thunk();
    if (r && r.error) message.error(`${t(failKey)}: ${r.error}`);
  });

  const allRoutes = useMemo(
    () => hosts.flatMap((h) => h.routes.map((route) => ({ host: h, route }))),
    [hosts],
  );

  const filteredRoutes = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return allRoutes.filter(({ host, route }) => {
      if (statusFilter === 'A' && !(host.enabled && route.active === 'primary')) return false;
      if (statusFilter === 'B' && !(host.enabled && route.active === 'alt')) return false;
      if (statusFilter === 'disabled' && host.enabled) return false;
      if (statusFilter === 'noalt' && route.alt) return false;
      if (ql) {
        const cols = field === 'domain' ? [host.domain]
          : field === 'path' ? [route.path]
            : field === 'a' ? [route.primary]
              : field === 'b' ? [route.alt]
                : [host.domain, route.path, route.primary, route.alt];
        if (!cols.some((c) => (c || '').toLowerCase().includes(ql))) return false;
      }
      return true;
    });
  }, [allRoutes, q, field, statusFilter]);

  const groups = useMemo(() => {
    const m = new Map();
    for (const { host, route } of filteredRoutes) {
      if (!m.has(host.domain)) m.set(host.domain, { host, routes: [] });
      m.get(host.domain).routes.push(route);
    }
    return [...m.values()];
  }, [filteredRoutes]);

  const dataSource = useMemo(() => groups.map((g) => ({
    key: g.host.file,
    isHost: true,
    host: g.host,
    children: g.routes.map((r) => ({ key: `${g.host.file}|${r.path}`, host: g.host, route: r })),
  })), [groups]);

  // Routes are collapsed by default. While a search/filter is active we expand all matching
  // groups so the matches are visible; clearing the filter collapses them again. With no
  // filter, manual expand/collapse is left untouched (and survives a refresh).
  const filterActive = q.trim() !== '' || statusFilter !== 'all';
  const prevFilter = useRef(false);
  useEffect(() => {
    if (filterActive) setExpanded(dataSource.map((d) => d.key));
    else if (prevFilter.current) setExpanded([]);
    prevFilter.current = filterActive;
  }, [filterActive, dataSource]);

  const bulkItems = filteredRoutes.filter((x) => x.host.managed);

  function bulk(target) {
    const items = bulkItems.map((x) => ({ domain: x.host.domain, path: x.route.path }));
    if (!items.length) return;
    modal.confirm({
      title: t(target === 'alt' ? 'hosts.confirmBulkB' : 'hosts.confirmBulkA', { count: items.length }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () => act(() => api.switchBulk(items, target), 'msg.editFailed'),
    });
  }

  function hostSwitch(host, target) {
    const items = host.routes.filter((r) => target === 'primary' || r.alt).map((r) => ({ domain: host.domain, path: r.path }));
    if (items.length) act(() => api.switchBulk(items, target), 'msg.editFailed');
  }

  function deleteHost(host) {
    modal.confirm({
      title: t('hosts.confirmDeleteHost', { domain: host.domain }),
      okType: 'danger', okText: t('common.delete'), cancelText: t('common.cancel'),
      onOk: () => act(() => api.del(host.domain), 'msg.deleteFailed'),
    });
  }

  // ---- backend A/B cell -------------------------------------------------------
  const backendCell = (host, route, which) => {
    const val = which === 'primary' ? route.primary : route.alt;
    const live = host.enabled && route.active === which;
    const color = live ? (which === 'primary' ? '#22c55e' : '#f59e0b') : undefined;
    const display = (
      <Typography.Text
        style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', color }}
        type={live ? undefined : 'secondary'}
      >
        {val || '—'}
      </Typography.Text>
    );
    return (
      <EditableText
        value={val || ''}
        display={display}
        editable={host.managed}
        placeholder={which === 'alt' ? t('hosts.altPlaceholder') : t('hosts.backendPlaceholder')}
        tooltip={which === 'alt' ? t('hosts.editBackendB') : t('hosts.editBackendA')}
        onSubmit={(v) => {
          const orig = val || '';
          if (v === orig) return;
          if (which === 'primary' && !v) return;
          act(() => api.setUpstream(host.domain, route.path, which, v), 'msg.editFailed');
        }}
      />
    );
  };

  // ---- host-row action menu ---------------------------------------------------
  const hostMenu = (host) => ({
    items: [
      { key: 'download', icon: <DownloadOutlined />, label: t('common.download') },
      host.enabled
        ? { key: 'disable', icon: <PoweroffOutlined />, label: t('common.disable') }
        : { key: 'enable', icon: <PlayCircleOutlined />, label: t('common.enable') },
      { type: 'divider' },
      { key: 'delete', icon: <DeleteOutlined />, danger: true, label: t('common.delete') },
    ],
    onClick: ({ key }) => {
      if (key === 'download') window.location.href = `/api/download?domain=${encodeURIComponent(host.domain)}`;
      else if (key === 'enable') act(() => api.enable(host.domain), 'msg.editFailed');
      else if (key === 'disable') act(() => api.disable(host.domain), 'msg.editFailed');
      else if (key === 'delete') deleteHost(host);
    },
  });

  const columns = [
    {
      title: t('hosts.col.hostPath'),
      key: 'hostpath',
      onCell: (r) => (r.isHost ? { colSpan: 4 } : {}),
      render: (_, r) => {
        if (r.isHost) {
          const h = r.host;
          const onA = h.routes.filter((x) => x.active === 'primary').length;
          const onB = h.routes.length - onA;
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <EditableText
                value={h.domain}
                display={<Typography.Text strong style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{h.domain}</Typography.Text>}
                tooltip={t('hosts.renameHost')}
                width={220}
                onSubmit={(v) => { if (v && v !== h.domain) act(() => api.rename(h.domain, v), 'msg.renameFailed'); }}
              />
              {!h.managed && <Tag color="warning" bordered={false}>{t('hosts.manual')}</Tag>}
              {!h.enabled && <Tag color="error" bordered={false}>{t('hosts.disabledTag')}</Tag>}
              <Space size={4} style={{ marginInlineStart: 'auto' }}>
                <Tag color={onA ? 'green' : 'default'} bordered={false} style={{ fontWeight: 600, margin: 0, opacity: onA ? 1 : 0.45 }}>{onA} {t('hosts.chip.A')}</Tag>
                <Tag color={onB ? 'gold' : 'default'} bordered={false} style={{ fontWeight: 600, margin: 0, opacity: onB ? 1 : 0.45 }}>{onB} {t('hosts.chip.B')}</Tag>
              </Space>
            </div>
          );
        }
        return (
          <EditableText
            value={r.route.path}
            display={<Typography.Text type="secondary" style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>{pathLabel(r.route.path)}</Typography.Text>}
            editable={r.host.managed}
            tooltip={t('hosts.renamePath')}
            placeholder={t('hosts.newPathPlaceholder')}
            onSubmit={(v) => { if (v && v !== r.route.path) act(() => api.renameRoute(r.host.domain, r.route.path, v), 'msg.renameFailed'); }}
          />
        );
      },
    },
    {
      title: t('hosts.col.backendA'),
      key: 'a',
      width: 200,
      onCell: (r) => (r.isHost ? { colSpan: 0 } : {}),
      render: (_, r) => (r.isHost ? null : backendCell(r.host, r.route, 'primary')),
    },
    {
      title: t('hosts.col.backendB'),
      key: 'b',
      width: 200,
      onCell: (r) => (r.isHost ? { colSpan: 0 } : {}),
      render: (_, r) => (r.isHost ? null : backendCell(r.host, r.route, 'alt')),
    },
    {
      title: t('hosts.col.live'),
      key: 'live',
      width: 80,
      align: 'center',
      onCell: (r) => (r.isHost ? { colSpan: 0 } : {}),
      render: (_, r) => {
        if (r.isHost) return null;
        const onB = r.host.enabled && r.route.active === 'alt';
        return <Tag color={onB ? 'gold' : 'green'} bordered={false} style={{ fontWeight: 600, margin: 0 }}>{onB ? 'B' : 'A'}</Tag>;
      },
    },
    {
      title: t('hosts.col.actions'),
      key: 'actions',
      width: 300,
      align: 'right',
      render: (_, r) => {
        if (r.isHost) {
          const h = r.host;
          return (
            <Space size={4}>
              <Tooltip title={t('hosts.hostToATip')}>
                <Button size="small" disabled={busy || !h.managed || !h.routes.some((x) => x.active === 'alt')} onClick={() => hostSwitch(h, 'primary')}>{t('hosts.toA')}</Button>
              </Tooltip>
              <Tooltip title={t('hosts.hostToBTip')}>
                <Button size="small" disabled={busy || !h.managed || !h.routes.some((x) => x.alt && x.active === 'primary')} onClick={() => hostSwitch(h, 'alt')}>{t('hosts.toB')}</Button>
              </Tooltip>
              <Tooltip title={t('hosts.addPath')}>
                <Button size="small" icon={<FileAddOutlined />} disabled={busy || !h.managed} onClick={() => setAddPathFor(h.domain)} />
              </Tooltip>
              <Tooltip title={t('hosts.testPath')}>
                <Button size="small" icon={<AimOutlined />} onClick={() => setTesterFor(h.domain)} />
              </Tooltip>
              <Tooltip title={t('hosts.peekEdit')}>
                <Button size="small" icon={<EyeOutlined />} onClick={() => openHostEditor(h.domain)} />
              </Tooltip>
              <Dropdown menu={hostMenu(h)} trigger={['click']}>
                <Button size="small" icon={<MoreOutlined />} />
              </Dropdown>
            </Space>
          );
        }
        const { host, route } = r;
        return (
          <Space size={4}>
            <Tooltip title={t('hosts.toATip')}>
              <Button size="small" disabled={busy || !host.managed || route.active === 'primary'} onClick={() => act(() => api.switch(host.domain, route.path, 'primary'), 'msg.editFailed')}>{t('hosts.toA')}</Button>
            </Tooltip>
            <Tooltip title={t('hosts.toBTip')}>
              <Button size="small" disabled={busy || !host.managed || !route.alt || route.active === 'alt'} onClick={() => act(() => api.switch(host.domain, route.path, 'alt'), 'msg.editFailed')}>{t('hosts.toB')}</Button>
            </Tooltip>
            <Popconfirm
              title={t('hosts.confirmDeletePath', { path: route.path, domain: host.domain })}
              okText={t('common.delete')} okType="danger" cancelText={t('common.cancel')}
              disabled={host.routes.length <= 1}
              onConfirm={() => act(() => api.delRoute(host.domain, route.path), 'msg.deleteFailed')}
            >
              <Button size="small" danger icon={<DeleteOutlined />} disabled={busy || host.routes.length <= 1} />
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const filterOptions = ['all', 'A', 'B', 'disabled', 'noalt'].map((k) => ({ value: k, label: t(`hosts.chip.${k}`) }));

  return (
    <Card variant="borderless" styles={{ body: { padding: screens.md ? 20 : 12 } }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder={t('hosts.filterPlaceholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 280, maxWidth: '100%' }}
          />
          <Select
            value={field}
            onChange={setField}
            style={{ width: 150 }}
            options={['any', 'domain', 'path', 'a', 'b'].map((k) => ({ value: k, label: t(`hosts.field.${k}`) }))}
          />
          <Segmented value={statusFilter} onChange={setStatusFilter} options={filterOptions} />
          <Typography.Text type="secondary" style={{ marginInlineStart: 'auto' }}>
            {t('hosts.shown', { count: filteredRoutes.length })}
          </Typography.Text>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddHostOpen(true)}>{t('hosts.addHost')}</Button>
          <Typography.Text type="secondary">·</Typography.Text>
          <Button disabled={busy || !bulkItems.length} onClick={() => bulk('alt')}>{t('hosts.bulkCutB')}</Button>
          <Button disabled={busy || !bulkItems.length} onClick={() => bulk('primary')}>{t('hosts.bulkRollA')}</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('hosts.bulkLabel', { count: bulkItems.length })}</Typography.Text>
          <Space style={{ marginInlineStart: 'auto' }}>
            <Button icon={<DownloadOutlined />} href="/api/download-all">{t('hosts.downloadAll')}</Button>
            <Button icon={<ExportOutlined />} href="/api/export">{t('hosts.exportCsv')}</Button>
          </Space>
        </div>

        <Table
          size="middle"
          columns={columns}
          dataSource={dataSource}
          pagination={false}
          scroll={{ x: 760 }}
          expandable={{
            expandedRowKeys: expanded,
            onExpandedRowsChange: (keys) => setExpanded(keys),
          }}
          rowClassName={(r) => (r.isHost ? 'host-row' : (r.host.enabled ? '' : 'route-disabled'))}
          locale={{ emptyText: `${t('hosts.empty')} ${hosts.length === 0 ? t('hosts.emptyImport') : ''}` }}
        />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('hosts.help')}</Typography.Text>
      </Space>

      <PromptModal
        open={addHostOpen}
        title={t('hosts.addHostTitle')}
        placeholder={t('hosts.newHostPlaceholder')}
        hint={t('hosts.newHostHint')}
        onCancel={() => setAddHostOpen(false)}
        onSubmit={async (v) => {
          const r = await api.addHost(v.toLowerCase());
          if (!(r && r.error)) run(async () => {});
          return r;
        }}
      />
      <PromptModal
        open={!!addPathFor}
        title={t('hosts.addPathTitle', { domain: addPathFor || '' })}
        placeholder={t('hosts.newPathPlaceholder')}
        hint={t('hosts.newRouteHint')}
        onCancel={() => setAddPathFor(null)}
        onSubmit={async (v) => {
          const r = await api.addRoute(addPathFor, v);
          if (!(r && r.error)) run(async () => {});
          return r;
        }}
      />
      <RouteTesterModal domain={testerFor} open={!!testerFor} onClose={() => setTesterFor(null)} />
    </Card>
  );
}
