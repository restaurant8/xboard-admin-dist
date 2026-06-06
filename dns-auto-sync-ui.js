(function () {
  if (window.__xboardDnsAutoSyncUiLoaded) return;
  window.__xboardDnsAutoSyncUiLoaded = true;

  var nodes = new Map();
  var serverConfig = {};
  var refreshPending = false;
  var lastActionNodeId = null;

  var CN_NODE = '\\u8282\\u70b9';
  var CN_ADDRESS = '\\u5730\\u5740';
  var CN_DOMAIN = '\\u57df\\u540d';
  var CF_TITLE = 'Cloudflare DNS \u81ea\u52a8\u540c\u6b65';
  var CF_GLOBAL_DESC = '\u914d\u7f6e\u5168\u5c40 Cloudflare DNS \u4fe1\u606f\uff1b\u6bcf\u4e2a\u8282\u70b9\u4ecd\u9700\u5728\u521b\u5efa\u6216\u7f16\u8f91\u8282\u70b9\u65f6\u5355\u72ec\u5f00\u542f\u3002';
  var CF_NODE_DESC = '\u5f00\u542f\u540e\uff0c\u8be5\u8282\u70b9\u57df\u540d\u4f1a\u81ea\u52a8\u89e3\u6790\u5230\u8282\u70b9\u4e0a\u62a5\u7684\u516c\u7f51 IP\uff0cIP \u53d8\u5316\u65f6\u4e5f\u4f1a\u81ea\u52a8\u66f4\u65b0\u3002';
  var NODE_INSTALL_LABEL = '\u5b89\u88c5\u547d\u4ee4';
  var NODE_INSTALL_COPIED = '\u5b89\u88c5\u547d\u4ee4\u5df2\u590d\u5236';
  var NODE_INSTALL_MISSING = '\u7f3a\u5c11\u5b89\u88c5\u547d\u4ee4';

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
    refreshNodeInstallMenuItems();
  }

  function captureServerConfig(payload) {
    var data = payload && payload.data ? payload.data : payload;
    if (!data) return;
    if (data.server) data = data.server;
    if (Object.prototype.hasOwnProperty.call(data, 'cloudflare_dns_zone_id')) {
      serverConfig = data;
      refreshCloudflareConfigBlock(false);
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
      var hasNodeText = new RegExp(CN_NODE + '|Add Node|Edit Node|New Node|Node|Server', 'i').test(text);
      var hasAddressText = new RegExp(CN_ADDRESS + '|' + CN_DOMAIN + '|Node Address|Server Host|Host|Address|Domain', 'i').test(text);
      return hasNodeText && hasAddressText;
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
      '<span class="block text-[12px] font-medium text-foreground/80">' + CF_TITLE + '</span>',
      '<span class="block text-[11px] leading-relaxed text-muted-foreground">' + CF_NODE_DESC + '</span>',
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
      return new RegExp(CN_ADDRESS + '|' + CN_DOMAIN + '|Node Address|Server Host|Host|Address|Domain', 'i').test(label.textContent || '');
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
    return new RegExp(
      '\\u8282\\u70b9\\u62c9\\u53d6|\\u8282\\u70b9\\u63a8\\u9001|\\u6d41\\u91cf\\u7edf\\u8ba1\\u6a21\\u5f0f|\\u6d41\\u91cf\\u7edf\\u8ba1\\u5468\\u671f|Node Pull|Node Push|Traffic Stats|server_pull_interval|server_push_interval|traffic_stats_mode|traffic_stats_interval',
      'i'
    ).test(text);
  }

  function findCloudflareConfigAnchor() {
    var pattern = /(\u6d41\u91cf\u7edf\u8ba1\u5468\u671f|\u6d41\u91cf\u7edf\u8ba1\u6a21\u5f0f|traffic_stats_interval|traffic_stats_mode|Traffic Stats)/i;
    var candidates = Array.prototype.slice.call(document.querySelectorAll('label,p,span,div'));
    var label = candidates.find(function (element) {
      var text = (element.textContent || '').trim();
      return text && text.length < 120 && pattern.test(text);
    });
    if (!label) return null;

    var current = label;
    while (current && current !== document.body) {
      var text = current.textContent || '';
      var hasField = current.querySelector && current.querySelector('input,select,textarea,[role="combobox"],button');
      if (hasField && pattern.test(text)) {
        return current;
      }
      current = current.parentElement;
    }

    return label.parentElement || null;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function findNodeByText(text) {
    var match;
    var idPattern = /#\s*(\d+)/g;
    while ((match = idPattern.exec(text || ''))) {
      if (nodes.has(match[1])) {
        return nodes.get(match[1]);
      }
    }

    var found = null;
    nodes.forEach(function (node) {
      if (found || !node) return;
      var name = String(node.name || '').trim();
      var host = String(node.host || '').trim();
      if (name && text.indexOf(name) !== -1 && (!host || text.indexOf(host) !== -1)) {
        found = node;
      }
    });
    return found;
  }

  function captureActionNodeFromEvent(event) {
    var control = event.target && event.target.closest && event.target.closest('button,[role="button"]');
    if (!control) return;

    var current = control;
    for (var depth = 0; current && current !== document.body && depth < 8; depth += 1) {
      if (current.getAttribute && current.getAttribute('role') === 'menu') return;
      var node = findNodeByText(current.textContent || '');
      if (node && node.id != null) {
        lastActionNodeId = String(node.id);
        return;
      }
      current = current.parentElement;
    }
  }

  function fallbackCopy(text) {
    var input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.top = '0';
    document.body.appendChild(input);
    input.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    input.remove();
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true;
      }).catch(function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function flashMenuItem(item, text) {
    if (!item) return;
    var original = item.innerHTML;
    item.textContent = text;
    window.setTimeout(function () {
      if (item.isConnected) {
        item.innerHTML = original;
      }
    }, 1200);
  }

  function createNodeInstallMenuItem(template, node) {
    var item = template ? template.cloneNode(false) : document.createElement('div');
    item.dataset.xbNodeInstallCommand = '1';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.className = template && template.className
      ? template.className
      : 'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent focus:bg-accent';
    item.innerHTML = [
      '<div class="flex w-full items-center">',
      '<span class="mr-2 inline-flex size-4 items-center justify-center" aria-hidden="true">&#x21e9;</span>',
      '<span>' + NODE_INSTALL_LABEL + '</span>',
      '</div>'
    ].join('');

    item.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();

      var command = node && (node.install_command || node.installCommand);
      if (!command) {
        flashMenuItem(item, NODE_INSTALL_MISSING);
        return;
      }

      copyText(command).then(function (ok) {
        flashMenuItem(item, ok ? NODE_INSTALL_COPIED : NODE_INSTALL_MISSING);
      });
    }, true);

    return item;
  }

  function refreshNodeInstallMenuItems() {
    if (!lastActionNodeId || !nodes.has(lastActionNodeId)) return;
    var node = nodes.get(lastActionNodeId);

    document.querySelectorAll('[role="menu"]').forEach(function (menu) {
      var text = menu.textContent || '';
      if (menu.querySelector('[data-xb-node-install-command]')) return;
      if (!(/\u7f16\u8f91|Edit/i.test(text) && /\u590d\u5236|Copy/i.test(text) && /\u5220\u9664|Delete/i.test(text))) return;

      var menuItems = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
      var copyItem = menuItems.find(function (item) {
        return /\u590d\u5236|^Copy$/i.test((item.textContent || '').trim());
      }) || menuItems[0];
      if (!copyItem) return;

      var item = createNodeInstallMenuItem(copyItem, node);
      copyItem.insertAdjacentElement('afterend', item);
    });
  }

  function createConfigInput(key, label, placeholder, description, type) {
    var value = serverConfig[key];
    if (value == null) value = '';
    return [
      '<div class="space-y-2">',
      '<label class="block text-sm font-medium">' + label + '</label>',
      '<input data-xb-cf-config="' + key + '" type="' + (type || 'text') + '" value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(placeholder) + '" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />',
      '<p class="text-xs leading-relaxed text-muted-foreground">' + description + '</p>',
      '</div>'
    ].join('');
  }

  function createConfigToggle(key, label, description) {
    return [
      '<div class="space-y-2">',
      '<label class="flex items-center gap-3 text-sm font-medium">',
      '<input data-xb-cf-config="' + key + '" type="checkbox" class="h-4 w-4" ' + (asBool(serverConfig[key]) ? 'checked' : '') + ' />',
      '<span>' + label + '</span>',
      '</label>',
      '<p class="text-xs leading-relaxed text-muted-foreground">' + description + '</p>',
      '</div>'
    ].join('');
  }

  function refreshCloudflareConfigBlock(force) {
    if (!document.body) return;
    var existing = document.querySelector('[data-xb-cloudflare-config]');
    if (!force && !shouldShowCloudflareConfig()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var anchor = findCloudflareConfigAnchor();
    if (!anchor || !anchor.parentElement) {
      if (existing) existing.remove();
      return;
    }

    var block = document.createElement('div');
    block.dataset.xbCloudflareConfig = '1';
    block.className = 'mt-6 space-y-5 rounded-md border bg-card p-4';
    block.innerHTML = [
      '<div class="space-y-1">',
      '<div class="text-base font-semibold">' + CF_TITLE + '</div>',
      '<div class="text-sm text-muted-foreground">' + CF_GLOBAL_DESC + '</div>',
      '</div>',
      createConfigInput('cloudflare_dns_api_token', 'Cloudflare API Token', 'Cloudflare API Token', '\u7528\u4e8e\u8c03\u7528 Cloudflare DNS API\uff0c\u5efa\u8bae\u53ea\u6388\u4e88\u76ee\u6807 Zone \u7684 DNS \u7f16\u8f91\u6743\u9650\u3002', 'password'),
      createConfigInput('cloudflare_dns_zone_id', 'Cloudflare Zone ID', 'Cloudflare Zone ID', '\u57df\u540d\u6240\u5728\u7684 Cloudflare Zone ID\uff0c\u7528\u6765\u5b9a\u4f4d\u8981\u66f4\u65b0\u7684 DNS \u8bb0\u5f55\u3002'),
      createConfigToggle('cloudflare_dns_proxied', 'Cloudflare \u4ee3\u7406', '\u662f\u5426\u5f00\u542f\u6a59\u4e91\u4ee3\u7406\uff1b\u4ec5\u5728\u4f60\u786e\u8ba4\u8be5\u8282\u70b9\u534f\u8bae\u652f\u6301 Cloudflare \u4ee3\u7406\u65f6\u5f00\u542f\u3002'),
      createConfigInput('cloudflare_dns_ttl', 'Cloudflare TTL', '1', 'DNS \u8bb0\u5f55 TTL\uff0c1 \u8868\u793a\u81ea\u52a8\uff0c\u5176\u4ed6\u503c\u4e3a\u79d2\u3002', 'number')
    ].join('');

    anchor.insertAdjacentElement('afterend', block);
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
      refreshNodeInstallMenuItems();
      refreshCloudflareConfigBlock(false);
    });
  }

  patchFetch();
  patchXhr();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleRefresh);
  } else {
    scheduleRefresh();
  }

  document.addEventListener('pointerdown', captureActionNodeFromEvent, true);
  document.addEventListener('click', captureActionNodeFromEvent, true);

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
