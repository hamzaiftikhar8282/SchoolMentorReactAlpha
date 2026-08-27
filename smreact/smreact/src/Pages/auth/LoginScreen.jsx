import AuthLayout from './AuthLayout';
import ForgotPasswordScreen from './ForgotPasswordScreen';
import { useState, useEffect } from 'react';
import { buildUrl, buildChainApiUrl } from '../../utils/apiConfig';
import { normalizePkPhone } from '../../utils/phone';

/* Network Head Office login kamyab hone par chain-schools-frontend (alag Vite app)
   ka portal khulta hai.
     • local dev  → :3002 (vite.config.js me strictPort)
     • deployed   → https://chain.schoolmentor.ai, REACT_APP_CHAIN_URL se (.env.production)
   Fallback sirf local dev ke liye hai: deployed par host to sahi banta tha magar
   port 3002 rehta tha, jahan kuch chal hi nahi raha — is liye wahan env var lazmi. */
const CHAIN_BASE_URL = String(
  process.env.REACT_APP_CHAIN_URL || `${window.location.protocol}//${window.location.hostname}:3002`
).trim().replace(/\/+$/, '');

/* Seedha dashboard par bhejte hain — chain app ka "/" waise bhi /dashboard par
   redirect karta hai, magar us se ek extra navigation hoti hai. */
const CHAIN_DASHBOARD_URL = `${CHAIN_BASE_URL}/dashboard`;


/* Server ka asli error nikaalo — JSON object ho ya plain text. "Internal Server Error:"
   jaisa prefix hata do taake user ko sirf matlab ka message dikhe. */
function serverMessage(data, raw) {
  const msg =
    data?.message ??
    data?.Message ??
    data?.error ??
    data?.title ??
    (typeof data === 'string' ? data : '') ??
    '';
  const text = String(msg || raw || '').trim();
  return text.replace(/^(internal\s+server\s+error|bad\s+request|error)\s*:\s*/i, '').trim();
}

export default function LoginScreen({ onLogin, onSignup }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState('');
  /* Chain portal se aane wale ko `?acct=network` milta hai (sign-out ya bina
     session ke koi page kholne par) — us soorat me Network Head Office tab
     pehle se selected ho, warna wo har baar khud tab badalta. */
  const [acctType, setAcctType] = useState(() => {
    try {
      const p = new URLSearchParams(window.location.search).get('acct');
      return String(p || '').toLowerCase() === 'network' ? 'network' : 'individual';
    } catch { return 'individual'; }
  });
  const [method,   setMethod]   = useState('phone');
  const [remember, setRemember] = useState(false);
  const [forgot,   setForgot]   = useState(false);
  const [forgotSoon, setForgotSoon] = useState(false);

  /* `?acct=network` apna kaam kar chuka (tab select ho gaya) — ab URL se hata
     do, warna user tab badal de to URL ghalat batata rahega, aur refresh par
     wapas network par chala jayega. replaceState → history me entry nahi. */
  useEffect(() => {
    try {
      if (!window.location.search.includes('acct=')) return;
      const url = new URL(window.location.href);
      url.searchParams.delete('acct');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch { /* purana browser — URL waisa hi reh jayega, koi nuqsan nahi */ }
  }, []);

  /* "Coming soon" toast khud-ba-khud 3s me chala jata hai. ERP shell ka
     ToastContainer yahan available nahi (login us se pehle render hota hai),
     is liye screen apna toast rakhta hai. */
  useEffect(() => {
    if (!forgotSoon) return;
    const id = setTimeout(() => setForgotSoon(false), 3000);
    return () => clearTimeout(id);
  }, [forgotSoon]);

  const isNetwork = acctType === 'network';

  const isEmailLogin = method === 'email';

  async function handleLogin() {
    /* Email sign-in abhi kisi bhi account type par live nahi hai. */
    if (isEmailLogin) {
      setError('Email login is not available yet. Please sign in with your phone number.');
      return;
    }
    if (!username.trim() || !password.trim()) {
      setError('Please enter your username and password.');
      return;
    }
    setError('');
   try {
    /* Do bilkul alag login endpoints — aur do alag SERVICES:
         Individual School   → ERP API        /api/Auth/login
                               { user_Name, password }
         Network Head Office → Chain Mgmt API /api/AHM_Login_Users/network-login
                               { contactNumber, password }
       Network wale endpoints ERP ke host par maujood hi nahi (404 dete hain) —
       wo alag service par hain, is liye buildChainApiUrl() use hota hai. */
    const res = await fetch(
      isNetwork
        ? buildChainApiUrl('/api/AHM_Login_Users/network-login')
        : buildUrl('/api/Auth/login'),
      {
        method: 'POST',
        headers: {
          'Accept': '*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          isNetwork
            ? { contactNumber: normalizePkPhone(username), password }
            : { user_Name: normalizePkPhone(username), password }
        ),
      },
    );

    /* Backend kabhi JSON deta hai aur kabhi plain-text (e.g. "Internal Server Error:
       This branch is not active."). Pehle text padho, phir JSON parse try karo — warna
       res.json() throw karke asli message chhupa deta tha aur "Network error" dikhta tha. */
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* plain-text response */ }
    console.log("Login Response:", data ?? raw);

    if (!res.ok) {
      /* 404 = endpoint hi maujood nahi. "Login failed" yahan gumraah karta hai
         (user samajhta hai password ghalat hai), is liye asli wajah batao. */
     if (res.status === 404) {
  setError(
    isNetwork
      ? 'Network User not found'
      : 'User not found'
  );
  return;
}
      setError(serverMessage(data, raw) || 'Login failed');
      return;
    }
    /* Deactivated account har jagah block — network ho ya school ERP. */
    if (data?.isActive === false) {
      setError('This account is deactivated. Please contact your administrator.');
      return;
    }

    /* Network Head Office: login yahin hota hai, phir chain-schools-frontend ka ERP
       khul jata hai. Wo app session localStorage me `csp_token`/`csp_user` se padhta
       hai (uska tokenStorage.js), isliye seedha wahi keys likh dete hain — chain side
       par koi extra code nahi chahiye aur token URL me expose nahi hota.

       NOTE: ye check ERP-only guards se PEHLE hai. Network head-office account kisi
       school ka employee nahi hota (koi employee_ID nahi), is liye neeche wala
       "pure parent" guard use galti se block kar deta tha. */
    if (isNetwork) {
      /* Token ke baghair chain portal ko signed-in nahi maana ja sakta — wo apne
         login screen par bhej dega. Aisi soorat me yahin saaf error dikhaao,
         warna user ko lagta hai "kuch hua hi nahi". */
      if (!data?.token) {
        setError('Login succeeded but no session token was returned. Please contact support.');
        return;
      }

      /* Network login ka response ERP se alag shape rakh sakta hai
         (ownerName / schoolNetwork / contactNumber), is liye har field ke
         mumkin naam check karte hain. */
      const netId    = data?.id ?? data?.userID ?? data?.networkID ?? null;
      const netName  = data?.displayName ?? data?.ownerName ?? data?.schoolNetwork ?? null;
      const netPhone = data?.contactNumber ?? data?.userName ?? normalizePkPhone(username);

      /* Network session `net_` prefix ke sath rakha jata hai, ERP wali keys se
         alag. AHEM: yahan plain `token` NAHI likhna — App.js use dekh kar
         samajhta hai ke school ERP me login ho chuka hai aur chain se wapas
         aane par login screen ki jagah Launch Setup khol deta tha. Network
         user school ka member hota hi nahi. */
      try {
        /* Kisi purane school-login ka session pada ho to hata do — warna chain
           se wapas aane par ERP usay live samajh kar Launch Setup khol deta. */
        ['token', 'branchID', 'UserID', 'employee_ID', 'accountType', 'launchSetup']
          .forEach((k) => sessionStorage.removeItem(k));

        sessionStorage.setItem('net_token', data.token);
        sessionStorage.setItem('net_accountType', 'network');
        if (netId    != null) sessionStorage.setItem('net_UserID', netId);
        if (netName)          sessionStorage.setItem('net_displayName', netName);
        if (netPhone)         sessionStorage.setItem('net_userName', netPhone);
        if (data?.schoolNetwork) sessionStorage.setItem('net_schoolNetwork', data.schoolNetwork);
      } catch (_) { /* private mode — handoff phir bhi chalega */ }

      /* Chain portal `name` render karta hai (sidebar + avatar initials), is liye
         wo bhi bhejna zaroori hai — sirf displayName bhejne par wahan naam khali
         aata tha. `schoolNetwork` bhi saath jata hai: sidebar sabse upar network
         ka naam dikhata hai aur uske paas iska koi doosra zariya nahi (wo apna
         login nahi karta). Baqi keys superset ke taur par rehti hain taake
         purane build bhi na tootein. */
      const cspUser = {
        id:            netId,
        name:          netName || netPhone || 'Head Office',
        userName:      netPhone,
        displayName:   netName,
        schoolNetwork: data?.schoolNetwork ?? null,
        email:         data?.email || '',
        role:          data?.accountType || 'Network Head Office',
        accountType:   data?.accountType ?? 'network',
      };

      /* Poora login response bhi saath jata hai, taake chain portal ki koi bhi
         screen wo field padh sake jo upar wale trimmed object me nahi hai.
         Token alag ja raha hai, is liye yahan se nikaal dete hain. */
      const { token: _handoffToken, ...profile } = data;

      /* Same-origin case (prod, jab dono ek hi domain par hon): seedha likh do. */
      try {
        localStorage.setItem('csp_token', data.token);
        localStorage.setItem('csp_user', JSON.stringify(cspUser));
        localStorage.setItem('csp_session', JSON.stringify(profile));
      } catch (_) { /* private mode / quota — neeche wala hash handoff phir bhi chalega */ }

      /* Cross-origin case (dev: ERP :3000, chain :3002 — localStorage alag hota hai).
         Session URL ke HASH me jata hai: hash server ko nahi jata, aur chain app
         boot par ise localStorage me daal kar turant URL se hata deta hai.

         URL chhota rakhne ke liye token ko RAW bhejte hain: JWT pehle se base64url
         hai (sirf A-Z a-z 0-9 - _ .), is liye encodeURIComponent uspar kuch nahi
         badalta — magar poore JSON ko encode karne se har `"` `{` `:` %XX ban kar
         URL bewajah lamba ho jata tha. Sirf user object ko encode karte hain. */
      const handoff = `t=${data.token}`
        + `&u=${encodeURIComponent(JSON.stringify(cspUser))}`
        + `&s=${encodeURIComponent(JSON.stringify(profile))}`;
      /* assign() nahi, replace(): assign history me entry chhorta hai, is liye
         chain portal par Back dabane par token wala URL dobara aa jata tha.
         replace() se login page history se hat jata hai aur token kahin nahi bachta. */
      window.location.replace(`${CHAIN_DASHBOARD_URL}#${handoff}`);
      return;
    }

    /* Sirf PURE parent accounts (parent portal, jinke paas koi employee record nahi) ERP me
       login NAHI kar sakte. STAFF (teacher/principal/admin) — chahe wo kisi student ke parent
       bhi hon (isParent:true) — hamesha login kar sakte hain. Pehle `isParent === true` check
       staff ko bhi galti se block kar deta tha (khaas kar deactivate→reactivate ke baad). */
    const isEmployee = !!(data?.employee_ID ?? data?.employeeID ?? data?.employee_Id ?? data?.empId);
    const roleStr = String(
      data?.accountType ?? data?.role ?? data?.roleName ?? data?.userType ?? ''
    ).trim().toLowerCase();
    if (!isEmployee && roleStr === 'parent') {
      setError('User not found');
      return;
    }

    if (data?.branchID) {
      sessionStorage.setItem("branchID", data.branchID);
    }
    if (data?.accountType) {
      sessionStorage.setItem("accountType", data.accountType);
    }
    if (data?.displayName) {
      sessionStorage.setItem("displayName", data.displayName);
    }
    if (data?.id) {
      sessionStorage.setItem("UserID", data.id);
    }
    if (data?.employee_ID) {
      sessionStorage.setItem("employee_ID", data.employee_ID);
    }
    if (data?.userName) {
      sessionStorage.setItem("userName", data.userName);
    }
    if (data?.token) {
      sessionStorage.setItem("token", data.token);
    }
    if (data?.launchSetup) {
      sessionStorage.setItem("launchSetup", data.launchSetup);
    }
    onLogin(data);

  } catch (err) {
    /* Yahan sirf tab aata hai jab request hi fail ho (server down / CORS / offline) —
       server ke bheje huay error ab upar handle hotay hain. */
    setError(err?.message ? `Network error: ${err.message}` : 'Network error. Please try again.');
    console.error(err);
  }
    // onLogin({ username });
    
  }




  /* Forgot-password apna poora screen hai (phone → OTP → naya password),
     is liye login form ki jagah wahi render hota hai. */
  if (forgot) {
    return <ForgotPasswordScreen onBack={() => { setForgot(false); setError(''); }} />;
  }

  return (
    <AuthLayout
      illustration="login"
      heading={isNetwork ? 'Network Head Office Login' : 'Welcome to School Mentor'}
      tagline={isNetwork
        ? 'Access and manage all schools in your network from one centralized account.'
        : 'Sign in to manage your school from one centralized platform.'}>

      {error && <div className="auth-error-box">{error}</div>}

      {/* Network Head Office ka password reset abhi taiyar nahi. */}
      {forgotSoon && (
        <div className="auth-toast" role="status">
          <i className="fa-solid fa-clock" />
          Password reset for Network Head Office is coming soon.
        </div>
      )}

      {/* Account type — Individual School yahin ERP login hai,
          School Network chain-schools-frontend ke login par bhej deta hai. */}
      <div className="auth-acct-select">
        <button type="button"
          className={`auth-acct-card${acctType === 'individual' ? ' is-active' : ''}`}
          onClick={() => { setAcctType('individual'); setMethod('phone'); setUsername(''); setError(''); setForgotSoon(false); }}>
          <i className="fa-solid fa-school" />
          <span>Individual School</span>
        </button>
        <button type="button"
          className={`auth-acct-card${acctType === 'network' ? ' is-active' : ''}`}
          onClick={() => { setAcctType('network'); setMethod('phone'); setUsername(''); setError(''); setForgotSoon(false); }}>
          <i className="fa-solid fa-building-columns" />
          <span>Network Head Office</span>
        </button>
      </div>

      {/* Sign-in method */}
      <div className="auth-method-select">
        <button type="button"
          className={`auth-method-tab${method === 'phone' ? ' is-active' : ''}`}
          onClick={() => { setMethod('phone'); setUsername(''); setError(''); setForgotSoon(false); }}>
          <i className="fa-solid fa-phone" /> Phone Number
        </button>
        <button type="button"
          className={`auth-method-tab${method === 'email' ? ' is-active' : ''}`}
          onClick={() => { setMethod('email'); setUsername(''); setError(''); }}>
          <i className="fa-solid fa-envelope" /> Email
          <span className="auth-soon-badge">Soon</span>
        </button>
      </div>

      {method === 'phone' ? (
        <>
          <label className="auth-label">Phone Number</label>
          <div className="auth-phone-row">
            <span className="auth-phone-code">+92</span>
            <div className="auth-input-wrap">
              <input className="auth-input" type="tel" placeholder="3XX XXXXXXX"
                value={username} onChange={e => setUsername(normalizePkPhone(e.target.value))}
                onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            </div>
          </div>
        </>
      ) : (
        <>
          <label className="auth-label">Email Address</label>
          <div className="auth-input-wrap">
            <span className="auth-input-icon"><i className="fa-solid fa-envelope" /></span>
            {/* Email login abhi kisi bhi account type ke liye live nahi —
                network aur individual school, dono par phone hi chalta hai. */}
            <input className="auth-input" type="email"
              placeholder="Enter your official email address"
              disabled value="" readOnly />
          </div>
          <div className="auth-notice-card">
            <i className="fa-solid fa-circle-info" />
            Email login and signup will be available soon. Please use your phone number for now.
          </div>
        </>
      )}

      <label className="auth-label">Password</label>
      <div className="auth-input-wrap">
        <span className="auth-input-icon"><i className="fa-solid fa-lock" /></span>
        <input className="auth-input" type={showPass ? 'text' : 'password'}
          placeholder="Enter your password"
          value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleLogin()} />
        <button className="auth-eye-btn" onClick={() => setShowPass(p => !p)} tabIndex={-1}>
          <i className={`fa-solid ${showPass ? 'fa-eye-slash' : 'fa-eye'}`} />
        </button>
      </div>

      <div className="auth-form-meta">
        <label className="auth-remember">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Remember me
        </label>
        {/* Forgot-password ka asli flow abhi sirf Individual School par chalta hai.
            Network Head Office ka reset baad me lagega jab uski API taiyar ho —
            tab tak button dikhta hai magar "coming soon" bata deta hai. */}
        <button type="button" className="auth-forgot"
          onClick={() => {
            if (isNetwork) {
              setError('');
              setForgotSoon(true);
              return;
            }
            setForgot(true);
          }}>
          Forgot password?
        </button>
      </div>

      <button className="auth-btn-primary" onClick={handleLogin}>
        {/* key → account type badalne par label bhi heading ke sath fade ho */}
        <span className="auth-btn-label" key={acctType}>
          {isNetwork ? 'Sign In to Network' : 'Sign In'}
        </span>
        <i className="fa-solid fa-arrow-right" />
      </button>

      <div className="auth-divider">or</div>

      {/* Active tab signup flow ko bata dete hain — network tab par network
          ke endpoints (network-send-otp / network-signup) use hote hain. */}
      <button className="auth-btn-ghost" onClick={() => onSignup?.(isNetwork)}>
        Create New Account
      </button>

      <p className="auth-terms">
        By signing in you agree to SchoolMentor's <a href="#terms">Terms of Service</a>
      </p>
    </AuthLayout>
  );
}
