# Spin Wheel Bot

GitHub Actions based headless-browser automation for PTCL "Spin the Wheel" ([my.ptcl.net.pk/SpinTheWheel](https://my.ptcl.net.pk/SpinTheWheel/Default.aspx)).
GitHub Pages par ek control panel bhi hai jahan numbers daal kar Start/Retry kiya ja sakta hai.

## Kaise kaam karta hai

1. `index.html` (GitHub Pages) se numbers `pending.json` mein queue hote hain (browser localStorage se token use hota hai).
2. `pending.json` par push hone par workflow `Spin Worker` auto-start hota hai.
3. Worker headless Chrome mein page kholta hai: number fill, captcha OCR (Tesseract) solve, terms accept, submit, spin.
4. Har number ka result `results.json` mein aata hai (ok / fail + reason + reward).
5. Frontend har 5s `results.json` poll karta hai — live progress, retry failed.

## Setup (ek dafa)

1. GitHub mein ek **fine-grained PAT** banao jo sirf is repo ko read/write kare (contents, actions). Frontend mein past karna hai.
2. Pages enable karo: repo → Settings → Pages → source `main` / root (ya `gh api` se).
3. Frontend Settings mein owner/repo/token daal kar save karo (localStorage).

## Files

| File | Kya hai |
|---|---|
| `script.js` | Worker bot (Puppeteer + Tesseract OCR) |
| `index.html` / `app.js` / `style.css` | GitHub Pages control panel |
| `pending.json` | Number queue (frontend likhta hai) |
| `results.json` | Live results (worker likhta hai) |
| `.github/workflows/spin.yml` | Actions workflow |

## Env vars (worker)

- `TARGET_URL` — target page (default upar wali)
- `PARALLEL` — kitne tab saath mein (default 2)
- `MAX_CAPTCHA_ATTEMPTS` — captcha retry count (default 6)
- `JOB_TIMEOUT_MIN` — max run minutes (default 45)
- `MIN/MAX_DELAY_MS` — numbers ke beech delay

> Note: Iska istemal campaign ToS ke mutabiq ho. Site response dena band kar de ya bot detect kare toh isko band karo.