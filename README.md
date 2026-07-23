# hr-document-box-fetcher

Automatically download documents from an **aconso HR Document Box**
(`*.hr-document-box.com`) into a local folder — e.g. a
[Paperless-ngx](https://docs.paperless-ngx.com/) consume directory, so your
payslips get OCR'd and archived without manual downloads.

## How it works

1. Logs in through the UI5 login form with headless Chromium (Playwright). The
   direct API login needs a CSRF token the browser sets up, so a real browser
   session is used just for the login.
2. Lists documents via `GET /api/v1/internal/documents`
   (fields: `FILE_INDEX`, `ATT_NAME`, `ATT_DOC_DATE`, `ATT_FOLDER_DESCRIPTION`, …).
3. Downloads each new document as PDF via
   `GET /api/v1/internal/documents/{FILE_INDEX}/pdf` into `OUT_DIR`.
4. Remembers processed `FILE_INDEX` values in `state/seen.json`, so re-runs only
   fetch new documents. Optional [ntfy](https://ntfy.sh) push on new docs / errors.

## Setup

```sh
cp .env.example .env                 # set HRBOX_HOST, OUT_DIR, optional NTFY_*
cp credentials.example credentials   # set HRBOX_USER (login email) + HRBOX_PASSWORD
docker compose run --rm fetcher
```

`credentials` and `.env` are gitignored. Credentials live in a **separate file**
(not `.env`) on purpose: aconso passwords often contain `$`, which
docker-compose would otherwise mangle as variable interpolation.

Schedule it with cron or a systemd timer to run daily, e.g.:

```
OnCalendar=*-*-* 08:00:00
```

## Debugging

Set `DEBUG=1` in `.env`. On failure the container writes the login DOM,
screenshots and the raw document JSON to `state/`, which is what you need to
adjust selectors or endpoints if aconso changes their frontend.

## Caveat

This drives a third-party portal's frontend/API. If aconso changes the login
page or API, the flow breaks — you'll get an ntfy error alert (if configured).
It's an unofficial integration; use it with your own account only.

## License

MIT
