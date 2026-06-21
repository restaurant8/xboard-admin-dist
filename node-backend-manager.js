(function () {
  if (window.__xboardBackendManagerLoaded) return;
  window.__xboardBackendManagerLoaded = true;

  var NAV_LABEL = '后端管理';
  var POLL_INTERVAL = 3000;

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
      case 'dispatched': return '<span class="text-amber-600">已下发…</span>';
      case 'started': return '<span class="text-amber-600">升级中…</span>';
      case 'success': return '<span class="text-emerald-600">成功 ' + escapeHtml(u.to_version || '') + '</span>';
      case 'skipped': return '<span class="text-muted-foreground">已是最新</span>';
      case 'failed': return '<span class="text-red-600" title="' + escapeHtml(u.error || '') + '">失败</span>';
      default: return escapeHtml(u.status);
    }
  }

  // ---- panel rendering ---------------------------------------------------

  function openPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.dataset.xbBackendPanel = '1';
    panelEl.className = 'fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4';
    panelEl.innerHTML = [
      '<div class="flex h-[85vh] w-full max-w-5xl flex-col rounded-lg border bg-background shadow-lg">',
      '<div class="flex items-center justify-between border-b px-5 py-3">',
      '<div class="text-base font-semibold">后端管理</div>',
      '<div class="flex items-center gap-2">',
      '<button data-xb-refresh type="button" class="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent">刷新</button>',
      '<button data-xb-upgrade-selected type="button" class="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">升级所选</button>',
      '<button data-xb-close type="button" class="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-accent">关闭</button>',
      '</div>',
      '</div>',
      '<div data-xb-body class="flex-1 overflow-auto px-5 py-3"><div class="py-10 text-center text-sm text-muted-foreground">加载中…</div></div>',
      '<div class="flex items-center gap-2 border-t px-5 py-2">',
      '<label class="whitespace-nowrap text-xs text-muted-foreground">下载源</label>',
      '<input data-xb-download-base type="text" placeholder="留空使用默认 GitHub releases" class="flex h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs" />',
      '</div>',
      '<div class="border-t px-5 py-2 text-xs text-muted-foreground">升级以「后端进程」为单位下发：同一台机器下的多个节点只会升级一次。</div>',
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
      if (body) body.innerHTML = '<div class="py-10 text-center text-sm text-red-600">加载失败：' + escapeHtml(err.message) + '</div>';
    });
  }

  function renderTable() {
    if (!panelEl) return;
    var body = panelEl.querySelector('[data-xb-body]');
    if (!body) return;

    if (!lastBackends.length) {
      body.innerHTML = '<div class="py-10 text-center text-sm text-muted-foreground">暂无运行中的后端。</div>';
      return;
    }

    var rows = lastBackends.map(function (b) {
      var typeLabel = b.type === 'machine' ? '机器' : '单节点';
      var online = b.online
        ? '<span class="inline-flex items-center gap-1 text-emerald-600">●在线</span>'
        : '<span class="inline-flex items-center gap-1 text-muted-foreground">●离线</span>';
      var key = backendKey(b);
      return [
        '<tr class="border-b last:border-0">',
        '<td class="py-2 pr-2"><input type="checkbox" data-xb-row="' + escapeHtml(key) + '" class="h-4 w-4" ' + (b.online ? '' : 'disabled') + ' /></td>',
        '<td class="py-2 pr-3"><div class="font-medium">' + escapeHtml(b.name) + '</div><div class="text-xs text-muted-foreground">' + typeLabel + (b.nodes_count ? ' · ' + b.nodes_count + ' 节点' : '') + '</div></td>',
        '<td class="py-2 pr-3">' + online + '</td>',
        '<td class="py-2 pr-3 font-mono text-xs">' + (escapeHtml(b.version) || '—') + '</td>',
        '<td class="py-2 pr-3 text-xs">' + (escapeHtml(b.kernel) || '—') + (b.arch ? ' / ' + escapeHtml(b.arch) : '') + '</td>',
        '<td class="py-2 pr-3 text-xs text-muted-foreground">' + fmtTime(b.last_seen_at) + '</td>',
        '<td class="py-2 pr-3 text-xs">' + upgradeStatusText(b) + '</td>',
        '<td class="py-2 text-right"><button type="button" data-xb-upgrade-one="' + escapeHtml(key) + '" class="inline-flex h-7 items-center rounded-md border px-2 text-xs hover:bg-accent ' + (b.online ? '' : 'pointer-events-none opacity-40') + '">升级</button></td>',
        '</tr>'
      ].join('');
    }).join('');

    body.innerHTML = [
      '<table class="w-full text-sm">',
      '<thead><tr class="border-b text-left text-xs text-muted-foreground">',
      '<th class="py-2 pr-2"><input type="checkbox" data-xb-select-all class="h-4 w-4" /></th>',
      '<th class="py-2 pr-3">后端</th><th class="py-2 pr-3">状态</th><th class="py-2 pr-3">版本</th>',
      '<th class="py-2 pr-3">内核/架构</th><th class="py-2 pr-3">最后心跳</th><th class="py-2 pr-3">升级</th><th></th>',
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
      lastBackends.forEach(function (b) {
        var st = map[backendKey(b)];
        if (st && JSON.stringify(st) !== JSON.stringify(b.upgrade)) { b.upgrade = st; changed = true; }
      });
      if (changed) renderTable();
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
    b.className = 'fixed bottom-4 right-4 z-[9990] inline-flex h-9 items-center rounded-full border bg-background px-4 text-sm shadow-md hover:bg-accent';
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
