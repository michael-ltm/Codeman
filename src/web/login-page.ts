/**
 * @fileoverview Self-contained login page for the custom (non-native) auth flow.
 *
 * Served by the auth middleware (`src/web/middleware/auth.ts`) with a 200 status
 * when an UNauthenticated browser navigates to a page (an `Accept: text/html`
 * GET that is not an `/api/*` call or a static asset). It replaces the native
 * browser Basic-Auth prompt that the removed `WWW-Authenticate` header used to
 * trigger — the user's hard requirement is "no native alert/confirm/prompt".
 *
 * The page is INTENTIONALLY self-contained: all CSS + JS are inlined and it
 * references NO authenticated resources (styles.css, app.js, fonts, etc.), so it
 * renders correctly for a client that has no session cookie. It mirrors
 * `index.html`'s pre-paint skin script (reads `localStorage['codeman:skin']` and
 * sets `data-skin` before first paint) so the login screen matches the user's
 * chosen theme with no flash-of-wrong-theme. The palette blocks below are a
 * minimal subset of the `[data-skin]` variables from `styles.css`.
 *
 * On submit it POSTs `{username,password}` to `/api/auth/login`; on
 * `{success:true}` it reloads (the freshly-issued `codeman_session` cookie then
 * lets the real app load); otherwise it shows an INLINE error (never `alert()`).
 * The whole page is static — no user-controlled value is interpolated — so there
 * is nothing to escape.
 */

/** Render the standalone login page HTML (full document, inline CSS + JS). */
export function renderLoginHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Codeman — Sign in</title>
<script>try{var s=localStorage.getItem('codeman:skin');if(s!=='og'&&s!=='daylight-green'&&s!=='daylight-blue')s='daylight-blue';document.documentElement.dataset.skin=s;}catch(e){document.documentElement.dataset.skin='daylight-blue';}</script>
<style>
:root{--bg-dark:#11151c;--bg-card:#1b222c;--bg-input:#202833;--border:#2b333f;--border-light:#3a4350;--text:#f3f6fa;--text-dim:#98a2b1;--text-muted:#717b8c;--accent:#38b6f0;--accent-hover:#3ec8ee;--accent-ink:#04223a;--danger:#f0616d;}
html[data-skin="daylight-blue"]{--bg-dark:#11151c;--bg-card:#1b222c;--bg-input:#202833;--border:#2b333f;--border-light:#3a4350;--text:#f3f6fa;--text-dim:#98a2b1;--text-muted:#717b8c;--accent:#38b6f0;--accent-hover:#3ec8ee;--accent-ink:#04223a;}
html[data-skin="daylight-green"]{--bg-dark:#11151c;--bg-card:#1b222c;--bg-input:#202833;--border:#2b333f;--border-light:#3a4350;--text:#f3f6fa;--text-dim:#98a2b1;--text-muted:#717b8c;--accent:#2fd3aa;--accent-hover:#34d8a0;--accent-ink:#062019;}
html[data-skin="og"]{--bg-dark:#09090b;--bg-card:#131316;--bg-input:#1a1a1f;--border:#232329;--border-light:#2e2e38;--text:#ececf0;--text-dim:#8b8b97;--text-muted:#52525e;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-ink:#0b1220;}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg-dark);color:var(--text);font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;min-height:100dvh}
.card{width:100%;max-width:360px;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:32px 28px;box-shadow:0 18px 48px rgba(0,0,0,.45)}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:6px}
.brand-dot{width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}
.brand-name{font-size:22px;font-weight:800;letter-spacing:.3px;color:var(--text)}
.subtitle{text-align:center;color:var(--text-dim);font-size:13px;margin:0 0 24px}
label{display:block;font-size:12px;font-weight:600;color:var(--text-dim);margin:0 0 6px;text-transform:uppercase;letter-spacing:.4px}
.field{margin-bottom:16px}
input{width:100%;background:var(--bg-input);border:1px solid var(--border-light);border-radius:9px;color:var(--text);font-size:15px;padding:11px 13px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(56,182,240,.18)}
button{width:100%;margin-top:8px;background:var(--accent);color:var(--accent-ink);border:0;border-radius:9px;font-size:15px;font-weight:700;padding:12px;cursor:pointer;transition:background .15s,opacity .15s}
button:hover{background:var(--accent-hover)}
button:disabled{opacity:.6;cursor:default}
.error{min-height:18px;margin:2px 0 4px;color:var(--danger);font-size:13px;text-align:center;font-weight:600}
.foot{margin-top:18px;text-align:center;color:var(--text-muted);font-size:11px}
</style>
</head>
<body>
<main class="card">
  <div class="brand"><span class="brand-dot"></span><span class="brand-name">Codeman</span></div>
  <p class="subtitle">Sign in to continue</p>
  <form id="loginForm" autocomplete="on">
    <div class="field">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <div class="error" id="loginError" role="alert" aria-live="polite"></div>
    <button type="submit" id="loginSubmit">Sign in</button>
  </form>
  <div class="foot">Codeman session manager</div>
</main>
<script>
(function(){
  var form=document.getElementById('loginForm');
  var err=document.getElementById('loginError');
  var btn=document.getElementById('loginSubmit');
  function show(msg){err.textContent=msg;}
  form.addEventListener('submit',function(e){
    e.preventDefault();
    show('');
    var username=document.getElementById('username').value;
    var password=document.getElementById('password').value;
    btn.disabled=true;
    fetch('/api/auth/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:username,password:password})
    }).then(function(res){
      if(res.status===429){show('尝试过多,请稍候');btn.disabled=false;return null;}
      return res.json().catch(function(){return null;});
    }).then(function(data){
      if(data&&data.success){location.reload();return;}
      if(data!==null){show('用户名或密码错误');btn.disabled=false;}
    }).catch(function(){show('网络错误,请重试');btn.disabled=false;});
  });
})();
</script>
</body>
</html>`;
}
