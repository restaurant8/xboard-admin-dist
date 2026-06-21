(function () {
  if (window.__xboardBackendManagerLoaded) return;
  window.__xboardBackendManagerLoaded = true;

  var NAV_LABEL = '后端管理';
  var POLL_INTERVAL = 3000;
  // 下发后超过该秒数仍停留在 dispatched（节点未发回 ack/result）即视为超时。
  var DISPATCH_TIMEOUT = 120;

  var panelEl = null;
  var pollTimer = null;
  var lastBackends = [];
  var downloadBase = '';
  var navButtonSeen = false;
  var attempts = 0;

  // ---- auth capture ------------------------------------------------------
  // The admin API authenticates via Sanctum (Authorization: Bearer <token>).
  // Injected scripts don't have the token, so we capture it from the SPA's own
  // requests (this script loads before the SPA module, so the patches are in
  // place before any request is made).
  var capturedAuth = '';

  function captureAuth(headers) {
    if (!headers) return;
    try {
      if (typeof headers.get === 'function') {
        var a = headers.get('Authorization') || headers.get('authorization');
        if (a) capturedAuth = a;
        return;
      }
      if (typeof headers === 'object') {
        for (var k in headers) {
          if (String(k).toLowerCase() === 'authorization' && headers[k]) capturedAuth = headers[k];
        }
      }
    } catch (e) {}
  }

  (function patchAuthCapture() {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          if (init && init.headers) captureAuth(init.headers);
          else if (input && input.headers) captureAuth(input.headers);
        } catch (e) {}
        return origFetch.apply(this, arguments);
      };
    }
    var origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        if (String(k).toLowerCase() === 'authorization' && v) capturedAuth = v;
      } catch (e) {}
      return origSet.apply(this, arguments);
    };
  })();

  function tokenFromStorage() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var v = localStorage.getItem(localStorage.key(i));
        if (!v) continue;
        if (/^\d+\|[A-Za-z0-9]{20,}$/.test(v)) return 'Bearer ' + v;
        if (v.length < 300 && v.indexOf('|') > 0 && v.charAt(0) === '{') {
          try {
            var o = JSON.parse(v);
            if (o && typeof o.token === 'string' && /^\d+\|/.test(o.token)) return 'Bearer ' + o.token;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return '';
  }

  function authHeader() {
    return capturedAuth || tokenFromStorage();
  }

  // ---- API helpers -------------------------------------------------------

  function adminApiBase() {
    var parts = String(window.location.pathname || '').split('/').filter(Boolean);
    var adminPath = parts[0] || '';
    if (!adminPath || adminPath === 'assets' || adminPath === 'api') return '';
    return '/api/v2/' + encodeURIComponent(adminPath);
  }

  function api(method, path, body) {
    var base = adminApiBase();
    if (!base || !window.fetch) return Promise.reject(new Error('no api base'));
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      }
    };
    var auth = authHeader();
    if (auth) init.headers['Authorization'] = auth;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return window.fetch(base + path, init).then(function (r) {
      return r.text().then(function (t) {
        var json;
        try { json = JSON.parse(t); } catch (e) { json = null; }
        if (!r.ok) {
          var msg = (json && (json.message || (json.data && json.data.message))) || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return json;
      });
    });
  }

  function fetchBackends() {
    return api('GET', '/server/machine/backends').then(function (json) {
      var data = (json && json.data) || {};
      lastBackends = Array.isArray(data.backends) ? data.backends : [];
      downloadBase = data.download_base || '';
      return lastBackends;
    });
  }

  // ---- helpers -----------------------------------------------------------

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function backendKey(b) { return b.type + ':' + b.id; }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  function upgradeStatusText(b) {
    var u = b.upgrade;
    if (!u || !u.status) return '';
    switch (u.status) {
      case 'dispatched':
        if (u.updated_at && (Date.now() / 1000 - u.updated_at) > DISPATCH_TIMEOUT) {
          return '<span style="color:#dc2626;" title="命令已下发但后端进程未在' + DISPATCH_TIMEOUT + '秒内响应，请确认节点在线且已升级到支持自更新的版本。">下发超时·未响应</span>';
        }
        return '<span style="color:#d97706;">已下发…</span>';
      case 'started': return '<span style="color:#d97706;">升级中…</span>';
      case 'success': return '<span style="color:#059669;">成功 ' + escapeHtml(u.to_version || '') + '</span>';
      case 'skipped': return '<span style="color:' + MUTED + ';">已是最新</span>';
      case 'failed': return '<span style="color:#dc2626;" title="' + escapeHtml(u.error || '') + '">失败</span>';
      default: return escapeHtml(u.status);
    }
  }

  // ---- panel rendering ---------------------------------------------------

  // Structural styles are inline (not Tailwind classes): the admin's compiled
  // Tailwind is purged, so arbitrary utilities like z-[9998]/bg-black/50/h-[85vh]
  // don't exist and would leave the modal unstyled (bleeding through the page).
  var BTN = 'display:inline-flex;align-items:center;height:32px;padding:0 12px;border-radius:6px;font-size:13px;line-height:1;cursor:pointer;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;';
  var BTN_PRIMARY = 'display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:6px;font-size:13px;line-height:1;cursor:pointer;border:none;background:hsl(var(--primary));color:hsl(var(--primary-foreground));font-weight:500;';
  var MUTED = 'hsl(var(--muted-foreground))';
  var BORDER = 'hsl(var(--border))';

  // Responsive styles live in a scoped <style> tag (not inline) so a media
  // query can collapse the wide table into stacked cards on narrow viewports.
  function injectStyles() {
    if (document.getElementById('xb-backend-styles')) return;
    var s = document.createElement('style');
    s.id = 'xb-backend-styles';
    s.textContent = [
      '.xb-bk-overlay{position:fixed;inset:0;z-index:99998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:16px;}',
      '.xb-bk-modal{display:flex;flex-direction:column;width:100%;max-width:980px;height:85vh;border-radius:10px;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;}',
      '.xb-bk-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid ' + BORDER + ';padding:12px 20px;}',
      '.xb-bk-title{font-size:16px;font-weight:600;}',
      '.xb-bk-actions{display:flex;gap:8px;flex-wrap:wrap;}',
      '.xb-bk-body{flex:1;overflow:auto;padding:12px 20px;}',
      '.xb-bk-foot{display:flex;align-items:center;gap:8px;border-top:1px solid ' + BORDER + ';padding:8px 20px;}',
      '.xb-bk-note{border-top:1px solid ' + BORDER + ';padding:8px 20px;font-size:12px;color:' + MUTED + ';}',
      '.xb-bk-table{width:100%;border-collapse:collapse;font-size:14px;}',
      '.xb-bk-table th{padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';text-align:left;font-size:12px;font-weight:500;color:' + MUTED + ';white-space:nowrap;}',
      '.xb-bk-table td{padding:8px 12px 8px 0;border-bottom:1px solid ' + BORDER + ';vertical-align:middle;}',
      '.xb-bk-name{font-weight:500;}',
      '.xb-bk-sub{font-size:12px;color:' + MUTED + ';}',
      '.xb-bk-mono{font-family:monospace;font-size:12px;word-break:break-all;}',
      '@media (max-width:760px){',
      '  .xb-bk-overlay{padding:0;}',
      '  .xb-bk-modal{max-width:100%;height:100%;border-radius:0;border:none;}',
      '  .xb-bk-head,.xb-bk-body,.xb-bk-foot,.xb-bk-note{padding-left:14px;padding-right:14px;}',
      '  .xb-bk-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}',
      '  .xb-bk-table,.xb-bk-table tbody,.xb-bk-table tr,.xb-bk-table td{display:block;width:auto;}',
      '  .xb-bk-table tr{border:1px solid ' + BORDER + ';border-radius:8px;padding:6px 12px;margin-bottom:10px;}',
      '  .xb-bk-table td{border:none;padding:5px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:right;}',
      '  .xb-bk-table td::before{content:attr(data-label);color:' + MUTED + ';font-size:12px;font-weight:500;text-align:left;flex:0 0 auto;}',
      '  .xb-bk-table td.xb-bk-nolabel::before{content:none;}',
      '  .xb-bk-table td.xb-bk-cell-name{flex-direction:column;align-items:flex-start;text-align:left;}',
      '  .xb-bk-table td.xb-bk-cell-action{justify-content:stretch;}',
      '  .xb-bk-table td.xb-bk-cell-action button{flex:1;justify-content:center;height:34px;}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  function openPanel() {
    if (panelEl) return;
    injectStyles();
    panelEl = document.createElement('div');
    panelEl.dataset.xbBackendPanel = '1';
    panelEl.className = 'xb-bk-overlay';
    panelEl.innerHTML = [
      '<div class="xb-bk-modal">',
      '<div class="xb-bk-head">',
      '<div class="xb-bk-title">后端管理</div>',
      '<div class="xb-bk-actions">',
      '<button data-xb-refresh type="button" style="' + BTN + '">刷新</button>',
      '<button data-xb-upgrade-selected type="button" style="' + BTN_PRIMARY + '">升级所选</button>',
      '<button data-xb-close type="button" style="' + BTN + '">关闭</button>',
      '</div>',
      '</div>',
      '<div data-xb-body class="xb-bk-body"><div style="padding:40px 0;text-align:center;font-size:13px;color:' + MUTED + ';">加载中…</div></div>',
      '<div class="xb-bk-foot">',
      '<label style="white-space:nowrap;font-size:12px;color:' + MUTED + ';">下载源</label>',
      '<input data-xb-download-base type="text" placeholder="留空使用默认 GitHub releases" style="flex:1;min-width:0;height:32px;border-radius:6px;border:1px solid ' + BORDER + ';background:transparent;color:inherit;padding:0 8px;font-size:12px;" />',
      '</div>',
      '<div class="xb-bk-note">升级以「后端进程」为单位下发：同一台机器下的多个节点只会升级一次。</div>',
      '</div>'
    ].join('');

    panelEl.addEventListener('click', function (e) { if (e.target === panelEl) closePanel(); });
    panelEl.querySelector('[data-xb-close]').addEventListener('click', closePanel);
    panelEl.querySelector('[data-xb-refresh]').addEventListener('click', function () { reload(); });
    panelEl.querySelector('[data-xb-upgrade-selected]').addEventListener('click', upgradeSelected);

    document.body.appendChild(panelEl);
    var baseInput = panelEl.querySelector('[data-xb-download-base]');
    if (baseInput && downloadBase) baseInput.value = downloadBase;
    reload();
    startPolling();
  }

  function closePanel() {
    stopPolling();
    if (panelEl) { panelEl.remove(); panelEl = null; }
  }

  function reload() {
    fetchBackends().then(renderTable).catch(function (err) {
      var body = panelEl && panelEl.querySelector('[data-xb-body]');
      if (body) body.innerHTML = '<div style="padding:40px 0;text-align:center;font-size:13px;color:#dc2626;">加载失败：' + escapeHtml(err.message) + '</div>';
    });
  }

  function renderTable() {
    if (!panelEl) return;
    var body = panelEl.querySelector('[data-xb-body]');
    if (!body) return;

    if (!lastBackends.length) {
      body.innerHTML = '<div style="padding:40px 0;text-align:center;font-size:13px;color:' + MUTED + ';">暂无运行中的后端。</div>';
      return;
    }

    var smallBtn = 'display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid ' + BORDER + ';background:hsl(var(--background));color:inherit;';

    var rows = lastBackends.map(function (b) {
      var typeLabel = b.type === 'machine' ? '机器' : '单节点';
      var online = b.online
        ? '<span style="color:#059669;">● 在线</span>'
        : '<span style="color:' + MUTED + ';">● 离线</span>';
      var key = backendKey(b);
      var statusHtml = upgradeStatusText(b);
      return [
        '<tr>',
        '<td class="xb-bk-nolabel"><input type="checkbox" data-xb-row="' + escapeHtml(key) + '" ' + (b.online ? '' : 'disabled') + ' /></td>',
        '<td class="xb-bk-cell-name xb-bk-nolabel"><div class="xb-bk-name">' + escapeHtml(b.name) + '</div><div class="xb-bk-sub">' + typeLabel + (b.nodes_count ? ' · ' + b.nodes_count + ' 节点' : '') + '</div></td>',
        '<td data-label="地址/IP" class="xb-bk-mono">' + (Array.isArray(b.ips) && b.ips.length ? b.ips.map(escapeHtml).join('<br>') : '—') + '</td>',
        '<td data-label="状态" style="font-size:13px;">' + online + '</td>',
        '<td data-label="版本" class="xb-bk-mono">' + (escapeHtml(b.version) || '—') + '</td>',
        '<td data-label="内核/架构" style="font-size:12px;">' + (escapeHtml(b.kernel) || '—') + (b.arch ? ' / ' + escapeHtml(b.arch) : '') + '</td>',
        '<td data-label="最后心跳" style="font-size:12px;color:' + MUTED + ';">' + fmtTime(b.last_seen_at) + '</td>',
        '<td data-label="升级状态" style="font-size:12px;">' + (statusHtml || '<span style="color:' + MUTED + ';">—</span>') + '</td>',
        '<td class="xb-bk-cell-action xb-bk-nolabel" style="text-align:right;"><button type="button" data-xb-upgrade-one="' + escapeHtml(key) + '" style="' + smallBtn + (b.online ? '' : 'pointer-events:none;opacity:.4;') + '">升级</button></td>',
        '</tr>'
      ].join('');
    }).join('');

    body.innerHTML = [
      '<table class="xb-bk-table">',
      '<thead><tr>',
      '<th><input type="checkbox" data-xb-select-all /></th>',
      '<th>后端</th><th>地址/IP</th><th>状态</th><th>版本</th>',
      '<th>内核/架构</th><th>最后心跳</th><th>升级状态</th><th></th>',
      '</tr></thead>',
      '<tbody>' + rows + '</tbody>',
      '</table>'
    ].join('');

    var selectAll = body.querySelector('[data-xb-select-all]');
    if (selectAll) {
      selectAll.addEventListener('change', function () {
        body.querySelectorAll('[data-xb-row]:not([disabled])').forEach(function (cb) { cb.checked = selectAll.checked; });
      });
    }
    body.querySelectorAll('[data-xb-upgrade-one]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var b = findBackend(btn.getAttribute('data-xb-upgrade-one'));
        if (b) confirmUpgrade([b]);
      });
    });
  }

  function findBackend(key) {
    return lastBackends.filter(function (b) { return backendKey(b) === key; })[0] || null;
  }

  function selectedBackends() {
    if (!panelEl) return [];
    var out = [];
    panelEl.querySelectorAll('[data-xb-row]:checked').forEach(function (cb) {
      var b = findBackend(cb.getAttribute('data-xb-row'));
      if (b) out.push(b);
    });
    return out;
  }

  function upgradeSelected() {
    var sel = selectedBackends();
    if (!sel.length) { window.alert('请先勾选要升级的后端。'); return; }
    confirmUpgrade(sel);
  }

  function confirmUpgrade(backends) {
    var names = backends.map(function (b) { return b.name; }).join('、');
    if (!window.confirm('确认升级以下后端到最新版本？\n\n' + names + '\n\n升级会重启后端服务，期间短暂断连。')) return;
    var targets = backends.map(function (b) { return { type: b.type, id: b.id }; });
    var payload = { targets: targets, version: 'latest' };
    var baseInput = panelEl && panelEl.querySelector('[data-xb-download-base]');
    var base = baseInput && baseInput.value ? baseInput.value.trim() : '';
    if (base) payload.download_base = base;
    api('POST', '/server/machine/upgrade', payload).then(function () {
      backends.forEach(function (b) { b.upgrade = { status: 'dispatched' }; });
      renderTable();
    }).catch(function (err) {
      window.alert('下发升级失败：' + err.message);
    });
  }

  // ---- status polling ----------------------------------------------------

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(pollStatuses, POLL_INTERVAL);
  }
  function stopPolling() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  function pollStatuses() {
    if (!panelEl || !lastBackends.length) return;
    var targets = lastBackends.map(function (b) { return { type: b.type, id: b.id }; });
    api('POST', '/server/machine/upgradeStatus', { targets: targets }).then(function (json) {
      var list = (json && json.data) || [];
      var map = {};
      list.forEach(function (item) { map[item.type + ':' + item.id] = item.status; });
      var changed = false;
      var pending = false;
      lastBackends.forEach(function (b) {
        var st = map[backendKey(b)];
        if (st && JSON.stringify(st) !== JSON.stringify(b.upgrade)) { b.upgrade = st; changed = true; }
        if (b.upgrade && (b.upgrade.status === 'dispatched' || b.upgrade.status === 'started')) pending = true;
      });
      // Re-render while anything is still in flight so the elapsed-time based
      // "下发超时" label appears even when the cached status itself is unchanged.
      if (changed || pending) renderTable();
    }).catch(function () {});
  }

  // ---- sidebar injection (as a child of the 节点管理 group) ---------------

  function findNodeManageButton() {
    var btns = document.querySelectorAll('nav button, aside button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-xb-backend-nav')) continue;
      if ((btns[i].textContent || '').replace(/\s+/g, '') === '节点管理') return btns[i];
    }
    return null;
  }

  // Insert "后端管理" as a sub-item inside the 节点管理 collapsible <ul>. The
  // submenu is only in the DOM while the group is expanded, and Vue re-renders
  // it, so this runs from a MutationObserver and re-injects whenever needed.
  function injectChildItem() {
    var btn = findNodeManageButton();
    if (!btn) return;
    navButtonSeen = true;
    var wrapper = btn.parentElement;
    if (!wrapper) return;
    var ul = wrapper.querySelector('ul');
    if (!ul) return; // group collapsed → nothing to inject into yet
    if (ul.querySelector('[data-xb-backend-child]')) return; // already present
    var sample = ul.querySelector('li');
    if (!sample) return;

    var li = sample.cloneNode(true);
    li.setAttribute('data-xb-backend-child', '1');
    var a = li.querySelector('a') || li;
    if (a.tagName === 'A') {
      a.setAttribute('href', 'javascript:void(0)');
      a.removeAttribute('aria-current');
    }
    if (a.classList) a.classList.remove('bg-secondary', 'text-secondary-foreground');

    // Relabel: replace the first non-empty text node inside the link.
    var labelSet = false;
    for (var i = 0; i < a.childNodes.length; i++) {
      var n = a.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) {
        n.nodeValue = NAV_LABEL;
        labelSet = true;
        break;
      }
    }
    if (!labelSet) a.appendChild(document.createTextNode(NAV_LABEL));

    var onClick = function (e) { e.preventDefault(); e.stopPropagation(); openPanel(); };
    li.addEventListener('click', onClick, true);

    ul.appendChild(li);
  }

  function injectFallbackButton() {
    if (document.querySelector('[data-xb-backend-fab]')) return;
    var b = document.createElement('button');
    b.dataset.xbBackendFab = '1';
    b.type = 'button';
    b.textContent = NAV_LABEL;
    b.setAttribute('style', 'position:fixed;bottom:16px;right:16px;z-index:99990;display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:9999px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:inherit;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);cursor:pointer;');
    b.addEventListener('click', openPanel);
    document.body.appendChild(b);
  }

  var injectPending = false;
  function scheduleInject() {
    if (injectPending) return;
    injectPending = true;
    window.requestAnimationFrame(function () {
      injectPending = false;
      injectChildItem();
      attempts++;
      // Only fall back to a floating launcher if the 节点管理 group never
      // appears (unexpected layout). Collapsed-but-present is not a failure.
      if (!navButtonSeen && attempts > 80) injectFallbackButton();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInject);
  } else {
    scheduleInject();
  }

  new MutationObserver(scheduleInject).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
