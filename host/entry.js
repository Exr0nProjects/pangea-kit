import { boot } from './boot.js'
boot().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="position:absolute;bottom:0;color:#f66">${String(e?.stack || e).replace(/</g, '&lt;')}</pre>`) })
