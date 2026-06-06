(function () {
  if (window.__xboardDnsAutoSyncUiLoaded) return;
  window.__xboardDnsAutoSyncUiLoaded = true;

  var nodes = new Map();
  var serverConfig = {};
  var refreshPending = false;

  function parseJson(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      return JSON.parse(value);
    } catch (e) {
      return null;
    }
  }

  function asBool(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function captureNodes(payload) {
    var list = payload && Array.isArray(payload.data) ? payload.data : payload;
    if (!Array.isArray(list)) return;
    list.forEach(function (node) {
      if (!node || node.id == null) return;
      nodes.set(String(node.id), node);
    });
    refreshNodeSwitches();
  }

  function captureServerConfig(payload) {
    var data = payload && payload.data ? payload.data : payload;
    if (!data) return;
    if (data.server) data = data.server;
    if (Object.prototype.hasOwnProperty.call(data, 'cloudflare_dns_zone_id')) {
      serverConfig = data;
      refreshCloudflareConfigBlock();
    }
  }

  function patchFetch() {
    if (!window.fetch) return;
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url;
      if (url && init && /\/server\/manage\/save(?:\?|$)/.test(url)) {
        init = Object.assign({}, init);
        init.body = patchNodeSaveBody(init.body);
      }
      if (url && init && /\/config\/save(?:\?|$)/.test(url)) {
        init = Object.assign({}, init);
        init.body = patchConfigSaveBody(init.body);
      }

      return originalFetch.call(this, input, init).then(function (response) {
        if (url && (/\/server\/manage\/getNodes(?:\?|$)/.test(url) || /\/config\/fetch(?:\?|$)/.test(url))) {
          response.clone().text().then(function (text) {
            var payload = parseJson(text);
            if (/\/server\/manage\/getNodes(?:\?|$)/.test(url)) captureNodes(payload);
            if (/\/config\/fetch(?:\?|$)/.test(url)) captureServerConfig(payload);
          }).catch(function () {});
        }
        return response;
      });
    };
  }

  function patchXhr() {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__xboardDnsUrl = url;
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      var url = this.__xboardDnsUrl || '';
      if (/\/server\/manage\/save(?:\?|$)/.test(url)) {
        body = patchNodeSaveBody(body);
      } else if (/\/config\/save(?:\?|$)/.test(url)) {
        body = patchConfigSaveBody(body);
      }

      if (/\/server\/manage\/getNodes(?:\?|$)/.test(url) || /\/config\/fetch(?:\?|$)/.test(url)) {
        this.addEventListener('load', function () {
          var payload = parseJson(this.responseText);
          if (/\/server\/manage\/getNodes(?:\?|$)/.test(url)) captureNodes(payload);
          if (/\/config\/fetch(?:\?|$)/.test(url)) captureServerConfig(payload);
        });
      }

      return originalSend.call(this, body);
    };
  }

  function patchNodeSaveBody(body) {
    var payload = parseJson(body);
    if (!payload) return body;

    var value = currentNodeSwitchValue(payload);
    if (value !== null) {
      payload.dns_auto_sync = value;
    }

    return JSON.stringify(payload);
  }

  function currentNodeSwitchValue(payload) {
    var dialog = findNodeDialog();
    var checkbox = dialog && dialog.querySelector('[data-xb-dns-auto-sync-input]');
    if (checkbox && checkbox.dataset.touched === '1') {
      return checkbox.checked;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'dns_auto_sync')) {
      return asBool(payload.dns_auto_sync);
    }

    if (payload.id != null && nodes.has(String(payload.id))) {
      return asBool(nodes.get(String(payload.id)).dns_auto_sync);
    }

    if (checkbox) {
      return checkbox.checked;
    }

    return null;
  }

  function patchConfigSaveBody(body) {
    var payload = parseJson(body);
    if (!payload) return body;

    var values = readCloudflareConfigValues();
    Object.keys(values).forEach(function (key) {
      payload[key] = values[key];
    });

    return JSON.stringify(payload);
  }

  function findNodeDialog() {
    return Array.prototype.find.call(document.querySelectorAll('[role="dialog"]'), function (dialog) {
      var text = dialog.textContent || '';
      return /添加节点|编辑节点|新建节点|Add Node|Edit Node|New Node|节点地址|Node Address|Server Host/i.test(text);
    }) || null;
  }

  function findMatchingNode(dialog) {
    var values = Array.prototype.map.call(dialog.querySelectorAll('input'), function (input) {
      return String(input.value || '').trim();
    }).filter(Boolean);

    var text = values.join('\n');
    var matched = null;
    nodes.forEach(function (node) {
      if (matched || !node) return;
      var host = String(node.host || '').trim();
      var name = String(node.name || '').trim();
      var port = String(node.server_port || node.port || '').trim();
      if (host && text.indexOf(host) !== -1 && (!name || text.indexOf(name) !== -1 || !port || text.indexOf(port) !== -1)) {
        matched = node;
      }
    });
    return matched;
  }

  function createNodeSwitch(checked) {
    var wrap = document.createElement('div');
    wrap.dataset.xbDnsAutoSync = '1';
    wrap.className = 'rounded-md border bg-muted/20 px-3 py-2';
    wrap.innerHTML = [
      '<label class="flex cursor-pointer items-start gap-3 font-mono text-xs">',
      '<input data-xb-dns-auto-sync-input type="checkbox" class="mt-0.5 h-4 w-4" />',
      '<span class="space-y-1">',
      '<span class="block text-[12px] font-medium text-foreground/80">Cloudflare 自动解析</span>',
      '<span class="block text-[11px] leading-relaxed text-muted-foreground">开启后，此节点的节点地址域名会自动解析到节点上报的公网 IP；IP 变化时也会自动更新。</span>',
      '</span>',
      '</label>'
    ].join('');

    var input = wrap.querySelector('input');
    input.checked = !!checked;
    input.dataset.touched = '0';
    input.addEventListener('change', function () {
      input.dataset.touched = '1';
    });

    return wrap;
  }

  function refreshNodeSwitches() {
    var dialog = findNodeDialog();
    if (!dialog) return;

    var existing = dialog.querySelector('[data-xb-dns-auto-sync]');
    var matched = findMatchingNode(dialog);
    var checked = matched ? asBool(matched.dns_auto_sync) : false;

    if (existing) {
      var input = existing.querySelector('[data-xb-dns-auto-sync-input]');
      if (input && input.dataset.touched !== '1') {
        input.checked = checked;
      }
      return;
    }

    var block = createNodeSwitch(checked);
    var hostLabel = Array.prototype.find.call(dialog.querySelectorAll('label'), function (label) {
      return /节点地址|Node Address|Server Host|Host/i.test(label.textContent || '');
    });
    var hostField = hostLabel && (hostLabel.closest('[class*="flex-1"]') || hostLabel.parentElement);
    var hostRow = hostField && hostField.parentElement;
    if (hostRow && hostRow.parentElement) {
      hostRow.insertAdjacentElement('afterend', block);
      return;
    }

    var body = dialog.querySelector('[class*="overflow-y-auto"]') || dialog;
    body.appendChild(block);
  }

  function shouldShowCloudflareConfig() {
    var text = document.body ? document.body.textContent || '' : '';
    return /节点拉取动作轮询间隔|节点推送动作轮询间隔|Node Pull|Node Push|server_pull_interval|server_push_interval/i.test(text);
  }

  function createConfigInput(key, label, placeholder, type) {
    var value = serverConfig[key];
    if (value == null) value = '';
    return [
      '<label class="space-y-1 text-sm">',
      '<span class="block font-medium">' + label + '</span>',
      '<input data-xb-cf-config="' + key + '" type="' + (type || 'text') + '" value="' + String(value).replace(/"/g, '&quot;') + '" placeholder="' + placeholder + '" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />',
      '</label>'
    ].join('');
  }

  function refreshCloudflareConfigBlock() {
    if (!document.body || !shouldShowCloudflareConfig()) return;
    if (document.querySelector('[data-xb-cloudflare-config]')) return;

    var block = document.createElement('div');
    block.dataset.xbCloudflareConfig = '1';
    block.className = 'mt-6 space-y-4 rounded-md border bg-card p-4';
    block.innerHTML = [
      '<div class="space-y-1">',
      '<div class="text-base font-semibold">Cloudflare DNS 自动解析</div>',
      '<div class="text-sm text-muted-foreground">这些是全局 Cloudflare 配置；每个节点仍需在创建/编辑节点时单独开启自动解析。</div>',
      '</div>',
      createConfigInput('cloudflare_dns_api_token', 'API Token', 'Cloudflare API Token', 'password'),
      createConfigInput('cloudflare_dns_zone_id', 'Zone ID', 'Cloudflare Zone ID'),
      '<label class="flex items-center gap-3 text-sm">',
      '<input data-xb-cf-config="cloudflare_dns_proxied" type="checkbox" class="h-4 w-4" ' + (asBool(serverConfig.cloudflare_dns_proxied) ? 'checked' : '') + ' />',
      '<span>开启 Cloudflare 代理（橙云）</span>',
      '</label>',
      createConfigInput('cloudflare_dns_ttl', 'TTL', '1 表示自动', 'number')
    ].join('');

    var main = document.querySelector('main') || document.querySelector('[class*="overflow-y-auto"]') || document.body;
    main.appendChild(block);
  }

  function readCloudflareConfigValues() {
    var result = {};
    document.querySelectorAll('[data-xb-cf-config]').forEach(function (input) {
      var key = input.getAttribute('data-xb-cf-config');
      if (!key) return;
      result[key] = input.type === 'checkbox' ? input.checked : input.value;
    });
    if (!result.cloudflare_dns_ttl) {
      result.cloudflare_dns_ttl = 1;
    }
    return result;
  }

  function scheduleRefresh() {
    if (refreshPending) return;
    refreshPending = true;
    window.requestAnimationFrame(function () {
      refreshPending = false;
      refreshNodeSwitches();
      refreshCloudflareConfigBlock();
    });
  }

  patchFetch();
  patchXhr();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh);
  } else {
    scheduleRefresh();
  }

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
