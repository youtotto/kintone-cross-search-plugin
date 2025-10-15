(async function () {
  'use strict';

  const config = kintone.plugin.app.getConfig(kintone.$PLUGIN_ID);
  if (config?.showFieldCode !== 'true') return;


  /* ───────────── licenseChecker.jsの読み込み ───────────── */
  function waitForLicenseChecker(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const checker = window.FUC_licenseChecker?.checkLicense;
        if (typeof checker === 'function') return resolve(checker);
        if (Date.now() - start > timeout) return reject(new Error('licenseChecker not loaded'));
        setTimeout(poll, 50);
      })();
    });
  }


  kintone.events.on(['app.record.detail.show'], async function (event) {

    try {
      const checkLicense = await waitForLicenseChecker();
      const ok = await checkLicense();
      if (!ok) return event;
    } catch (e) {
      return event;
    }

    const appId = kintone.app.getId();

    // フィールド一覧取得（最初の1回だけキャッシュ）
    if (!window._fieldCodeLabelCache) {
      window._fieldCodeLabelCache = {};
      return kintone.api(kintone.api.url('/k/v1/app/form/fields', true), 'GET', { app: appId }).then(resp => {
        window._fieldCodeLabelCache = resp.properties;
        injectFieldCodes(resp.properties);
      });
    } else {
      injectFieldCodes(window._fieldCodeLabelCache);
    }

    function injectFieldCodes(fieldMap) {
      Object.keys(fieldMap).forEach(code => {
        const field = fieldMap[code];
        // テーブル内フィールドは対象外（別途対応可能）
        if (field.type === 'SUBTABLE') return;

        const labelEls = document.querySelectorAll('.control-label-text-gaia');
        labelEls.forEach(labelEl => {
          const labelText = labelEl.textContent.trim().replace(/\*$/, '').trim();
          if (labelText === field.label && !labelEl.querySelector('.field-code-tag')) {
            const span = document.createElement('span');
            span.textContent = ` [${code}]`;
            span.className = 'field-code-tag';
            span.style.fontSize = '11px';
            span.style.color = '#888';
            labelEl.appendChild(span);
          }
        });
      });
    }

    return event;
  });

})();
