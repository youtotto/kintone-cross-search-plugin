// 📁 AL_licenseChecker.js

/**
 * ライセンスをチェックし、有効ならtrueを返す（localStorage対応）
 */
async function checkLicense() {

  const LICENSE_CACHE_HOURS = 24 * 7;
  const productId = 'f41b1d9a-97f3-e4f2-2761-87e2c9b57b0c';
  const productName = 'フィールド使用状況チェッカー';

  /**
   * 認証キャッシュのキーを生成
   */
  function getLicenseCacheKey(productId, domain) {
    return `license_${productId}_${domain}`;
  }

  /**
   * キャッシュが有効かどうかを確認
   */
  function isLicenseCacheValid(cache) {
    if (!cache.timestamp || !cache.result) return false;
    const elapsed = Date.now() - cache.timestamp;
    return elapsed < LICENSE_CACHE_HOURS * 60 * 60 * 1000;
  }

  /**
   * kintoneドメインを取得（例: "sample.cybozu.com"全体で使う）
   */
  function getKintoneDomain() {
    return location.hostname;
  }

  function kucNotification(text, type, duration) {
    const Kuc = window.Kucs["1.20.0"];
    const notification = new Kuc.Notification({
      text: text,
      type: type, // 'info', 'success', 'danger' から選択
      duration: duration
    });
    notification.open();
  }

  const domain = getKintoneDomain();
  const key = getLicenseCacheKey(productId, domain);

  // localStorage確認
  const cached = JSON.parse(localStorage.getItem(key) || '{}');
  if (isLicenseCacheValid(cached)) {
    if (cached.result === 'ok') {
      console.log(`${productName}：✅ キャッシュ認証OK`);
      return true;
    }
  }


  // fetchでライセンス確認
  try {

    const res = await fetch(`https://nestrec.com/_functions/checkLicense?productId=${productId}&kintoneDomain=${domain}`);
    const data = await res.json();

    // // 両方に保存
    localStorage.setItem(key, JSON.stringify({ result: data.result, timestamp: Date.now() }));

    if (data.result === 'ok') {
      console.log('LicenseType: ', data.licenseType);
      console.log(`${productName}：✅ fetch認証OK`);
      return true;
    }

    console.log(`${productName}：❌ fetch認証NG`);
    const fetchNGtext = `${productName}：ライセンス未登録です。`
    kucNotification(fetchNGtext, 'danger', 3000);
    return false;

  } catch (e) {
    const licenseCheckErr = `${productName}：ライセンス確認に失敗しました。通信環境をご確認ください。`;
    kucNotification(licenseCheckErr, 'danger', 3000);
    console.error('✖', e);
    return false;
  }
}

// グローバルに公開
if (typeof window !== 'undefined') {
  window.FUC_licenseChecker = { checkLicense };
}
