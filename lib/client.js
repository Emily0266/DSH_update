/**
 * dsh-version-panel — client half.
 *
 * 手写的 DSH 客户端模块（ModuleLoader 格式，无需构建工具）。
 * 在「设置」里注册一个「版本」页，通过同源 fetch 调用 host 半的 /dsh-version/api。
 */
window.__ModuleLoader__.load({
  id: 'dsh-version-panel',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var h = React.createElement;

    var API = '/dsh-version/api';

    /** 调用 host 接口。action 为空表示 GET 状态。 */
    async function callApi(action, payload) {
      var init;
      if (action === undefined || action === null) {
        init = { method: 'GET' };
      } else {
        var body = Object.assign({ action: action }, payload || {});
        init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
      }
      var res = await fetch(API, init);
      var text = await res.text();
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error('响应不是合法 JSON（HTTP ' + res.status + '）');
      }
      if (!res.ok && data && data.error) throw new Error(data.error);
      return data;
    }

    function formatTime(value) {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleString();
      } catch (err) {
        return String(value);
      }
    }

    var styles = {
      wrap: { display: 'grid', gap: '14px', maxWidth: '820px', padding: '2px 0' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, #e5e6eb)',
        borderRadius: '12px',
        padding: '16px',
        display: 'grid',
        gap: '12px',
      },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
      },
      label: { opacity: 0.65, fontSize: '13px' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '14px',
      },
      note: { opacity: 0.65, fontSize: '12px', lineHeight: 1.6, margin: 0 },
      actions: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
      error: {
        border: '1px solid color-mix(in srgb, #e5484d 35%, transparent)',
        background: 'color-mix(in srgb, #e5484d 8%, transparent)',
        borderRadius: '10px',
        padding: '10px 12px',
        fontSize: '13px',
        color: '#c62a2f',
      },
      pre: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-l2, #f5f6f7)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: '220px',
        overflow: 'auto',
      },
    };

    function badge(text, tone) {
      var palette = {
        ok: { bg: 'color-mix(in srgb, #17a34a 14%, transparent)', fg: '#15803d' },
        warn: { bg: 'color-mix(in srgb, #f59e0b 16%, transparent)', fg: '#b45309' },
        info: { bg: 'color-mix(in srgb, #3b82f6 14%, transparent)', fg: '#1d4ed8' },
        muted: { bg: 'var(--dsw-alias-bg-l2, #f2f3f5)', fg: 'inherit' },
      };
      var tone2 = palette[tone] || palette.muted;
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '12px',
            background: tone2.bg,
            color: tone2.fg,
            whiteSpace: 'nowrap',
          },
        },
        text,
      );
    }

    function button(label, options) {
      var opts = options || {};
      return h(
        'button',
        {
          type: 'button',
          onClick: opts.onClick,
          disabled: opts.disabled === true,
          style: {
            minHeight: '32px',
            padding: '0 14px',
            borderRadius: '8px',
            fontSize: '13px',
            cursor: opts.disabled === true ? 'not-allowed' : 'pointer',
            opacity: opts.disabled === true ? 0.55 : 1,
            border: opts.primary === true ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2, #d8dade)',
            background: opts.primary === true ? 'var(--dsw-alias-accent, #4d6bfe)' : 'transparent',
            color: opts.primary === true ? '#fff' : 'inherit',
          },
        },
        label,
      );
    }

    function VersionRow(props) {
      return h(
        'div',
        { style: styles.row },
        h('span', { style: styles.label }, props.label),
        h(
          'span',
          { style: styles.mono },
          props.value ? props.value : h('span', { style: { opacity: 0.6 } }, '未知'),
          props.extra ? h('span', { style: { ...styles.label, marginLeft: '8px' } }, props.extra) : null,
        ),
      );
    }

    function Panel() {
      var statePair = React.useState(null);
      var state = statePair[0];
      var setState = statePair[1];

      var loadingPair = React.useState(true);
      var loading = loadingPair[0];
      var setLoading = loadingPair[1];

      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      var errorPair = React.useState(null);
      var error = errorPair[0];
      var setError = errorPair[1];

      var progressPair = React.useState(null);
      var progress = progressPair[0];
      var setProgress = progressPair[1];

      var load = React.useCallback(async function (force) {
        setError(null);
        try {
          var data = force ? await callApi('check') : await callApi();
          setState(data);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setLoading(false);
          setBusy(false);
        }
      }, []);

      React.useEffect(function () {
        void load(false);
      }, [load]);

      var runningNow = (state && state.update && state.update.running) === true || (progress && progress.running) === true;

      React.useEffect(
        function () {
          if (!runningNow) return undefined;
          var timer = window.setInterval(async function () {
            try {
              var data = await callApi('progress');
              setProgress(data);
              if (data && data.done === true) {
                window.clearInterval(timer);
                void load(false);
              }
            } catch (err) {
              /* 轮询失败不打断界面 */
            }
          }, 2000);
          return function () {
            window.clearInterval(timer);
          };
        },
        [runningNow, load],
      );

      var onCheck = React.useCallback(
        function () {
          setBusy(true);
          void load(true);
        },
        [load],
      );

      var onUpdate = React.useCallback(async function () {
        var ok = window.confirm(
          '将对源码仓库执行：\n\n' +
            '  git pull\n' +
            '  pnpm install\n' +
            '  pnpm run build:lib\n' +
            '  pnpm run build:web\n\n' +
            '这会修改源码目录，完成后需要重启 dsh web。确认继续？',
        );
        if (!ok) return;
        setError(null);
        setBusy(true);
        try {
          await callApi('update', { confirm: true });
          setProgress({ running: true, done: false, steps: [] });
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        } finally {
          setBusy(false);
        }
      }, []);

      if (loading === true && state === null && error === null) {
        return h('div', { style: styles.wrap }, h('div', { style: styles.card }, '正在读取版本信息…'));
      }

      var children = [];
      children.push(h('h3', { key: 'title', style: styles.title }, '版本与更新'));

      if (error !== null) {
        children.push(h('div', { key: 'error', style: styles.error, role: 'alert' }, error));
      }

      if (state !== null) {
        var updateAvailable = state.updateAvailable === true;
        var latestText = state.latest ? state.latest : null;

        var statusBadge;
        if (state.current === null) {
          statusBadge = badge('无法确认当前版本', 'warn');
        } else if (state.latest === null) {
          statusBadge = badge('上游检查失败', 'warn');
        } else if (updateAvailable) {
          statusBadge = badge('有新版本可用', 'warn');
        } else {
          statusBadge = badge('已是最新', 'ok');
        }

        children.push(
          h(
            'div',
            { key: 'card', style: styles.card },
            h('div', { style: styles.row }, h('span', { style: styles.label }, '状态'), statusBadge),
            h(VersionRow, { label: '当前版本', value: state.current, extra: state.currentDir || null }),
            h(VersionRow, { label: '最新版本', value: latestText, extra: state.latestTag || null }),
            h(VersionRow, {
              label: '检查来源',
              value: state.upstreamSource === 'releases' ? 'GitHub releases' : state.upstreamSource === 'tags' ? 'GitHub tags' : '—',
              extra: state.checkedAt ? '检查于 ' + formatTime(state.checkedAt) : null,
            }),
            h(VersionRow, {
              label: '部署方式',
              value: state.installType === 'source-repo' ? '源码仓库' : 'npm 包',
              extra: state.repoRoot || null,
            }),
            state.upstreamError
              ? h('p', { style: styles.note }, '上游检查提示：' + state.upstreamError)
              : null,
            h(
              'div',
              { style: styles.actions },
              button(busy ? '检查中…' : '检查更新', { onClick: onCheck, disabled: busy }),
              state.installType === 'source-repo'
                ? button(runningNow ? '更新进行中…' : '一键本地更新', {
                    onClick: onUpdate,
                    primary: true,
                    disabled: busy || runningNow,
                  })
                : null,
              h(
                'a',
                {
                  href: state.releaseUrl || 'https://github.com/deepseek-ai/deepseek-harness/releases',
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { ...styles.label, alignSelf: 'center', textDecoration: 'underline' },
                },
                '查看上游发布',
              ),
            ),
          ),
        );

        if (state.installType === 'source-repo' && state.updateCommand) {
          children.push(
            h(
              'div',
              { key: 'cmd', style: styles.card },
              h('div', { style: styles.row }, h('span', { style: styles.label }, '手动更新命令')),
              h('pre', { style: styles.pre }, state.updateCommand),
              h('p', { style: styles.note }, '在仓库根目录执行后，重启 dsh web 生效。'),
            ),
          );
        }

        var shown = progress !== null && progress.steps ? progress : state.update;
        if (shown && shown.steps && shown.steps.length > 0) {
          var stepNodes = shown.steps.map(function (step, index) {
            var tone = step.status === 'ok' ? 'ok' : step.status === 'failed' ? 'warn' : 'info';
            var lines = step.lines && step.lines.length > 0 ? step.lines.join('\n') : null;
            return h(
              'div',
              { key: 'step-' + index, style: { display: 'grid', gap: '6px' } },
              h(
                'div',
                { style: styles.row },
                h('span', { style: styles.mono }, step.name),
                badge(step.status === 'ok' ? '完成' : step.status === 'failed' ? '失败' : '进行中', tone),
              ),
              lines !== null ? h('pre', { style: styles.pre }, lines) : null,
            );
          });

          var done = shown.done === true;
          var success = shown.success === true;

          children.push(
            h(
              'div',
              { key: 'progress', style: styles.card },
              h(
                'div',
                { style: styles.row },
                h('span', { style: styles.label }, '更新进度'),
                done ? (success ? badge('全部完成', 'ok') : badge('更新中断', 'warn')) : badge('运行中', 'info'),
              ),
              stepNodes,
              done && success
                ? h('p', { style: styles.note }, '更新已完成。请重启 dsh web 使新版本生效。')
                : null,
              shown.error ? h('p', { style: styles.error }, shown.error) : null,
            ),
          );
        }

        if (state.releaseNotes) {
          children.push(
            h(
              'details',
              { key: 'notes', style: styles.card },
              h('summary', { style: { cursor: 'pointer', fontSize: '13px' } }, '最新版本变更说明'),
              h('pre', { style: { ...styles.pre, marginTop: '10px' } }, state.releaseNotes),
            ),
          );
        }
      }

      return h('div', { style: styles.wrap }, children);
    }

    /** 注册设置页。 */
    function apply(ctx) {
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'version-panel', order: 31, label: '版本' },
          function () {
            return h(Panel);
          },
        );
      });
    }

    exports.apply = apply;
    exports.name = 'dsh-version-panel';
    exports.inject = ['slots'];
    return module.exports;
  },
});
