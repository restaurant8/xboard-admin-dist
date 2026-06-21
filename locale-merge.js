(function () {
  var upstream = window.__XBOARD_UPSTREAM_TRANSLATIONS__ || {};
  var custom = window.XBOARD_TRANSLATIONS || {};

  function merge(base, overrides) {
    var result = {};
    Object.keys(base || {}).forEach(function (key) {
      result[key] = base[key];
    });
    Object.keys(overrides || {}).forEach(function (key) {
      var left = result[key];
      var right = overrides[key];
      if (
        left && right &&
        typeof left === 'object' && typeof right === 'object' &&
        !Array.isArray(left) && !Array.isArray(right)
      ) {
        result[key] = merge(left, right);
      } else {
        result[key] = right;
      }
    });
    return result;
  }

  window.XBOARD_TRANSLATIONS = merge(upstream, custom);
  delete window.__XBOARD_UPSTREAM_TRANSLATIONS__;
})();
