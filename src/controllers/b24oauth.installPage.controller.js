'use strict';

/**
 * Страница завершения установки приложения в Bitrix24.
 * Должна открываться внутри iframe Bitrix24 во время установки,
 * чтобы был доступен объект BX24 и можно было вызвать BX24.installFinish().
 */
async function installPage(_req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Bitrix24 App Install</title>
  <style>
    body { font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif; padding: 20px; }
    .muted { color: #666; font-size: 14px; }
    .ok { color: #0a7f2e; font-weight: 600; }
    code { background: #f3f3f3; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="ok">Установка приложения: завершение...</div>
  <p class="muted">
    Если страница открыта внутри Bitrix24, будет вызван <code>BX24.installFinish()</code>.
    Если открыть напрямую в браузере — BX24 недоступен и ничего не произойдёт.
  </p>

  <script src="https://api.bitrix24.com/api/v1/"></script>
  <script>
    (function () {
      function finish() {
        try {
          if (window.BX24 && typeof window.BX24.installFinish === 'function') {
            window.BX24.installFinish();
            document.querySelector('.ok').textContent = 'Установка приложения: завершено ✅';
            return;
          }
        } catch (e) {}

        document.querySelector('.ok').textContent = 'BX24 недоступен: открой страницу через Bitrix24 installer';
      }

      setTimeout(finish, 50);
      setTimeout(finish, 500);
      setTimeout(finish, 1500);
    })();
  </script>
</body>
</html>`;

  return res.status(200).send(html);
}

module.exports = { installPage };
