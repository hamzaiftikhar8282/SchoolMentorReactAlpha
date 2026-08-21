import { useState, useRef, useEffect, useCallback } from 'react';
import AuthLayout from './AuthLayout';
import { buildUrl } from '../../utils/apiConfig';
import { normalizePkPhone } from '../../utils/phone';



const OTP_LENGTH = 4;
const RESEND_SECONDS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* localStorage key jahan bheji hui OTP rakhi jati hai — ERP ke change-password
   flow jaisa hi pattern (wahan key 'profile_pwd_otp' hai, dekhein
   erp/services/profileService.js). Application → Local Storage me nazar aati hai. */
const FORGOT_OTP_KEY = 'forget_otp';

const otpStore = {
  save(otp) {
    try { localStorage.setItem(FORGOT_OTP_KEY, String(otp)); } catch { /* private mode */ }
  },
  read() {
    try { return (localStorage.getItem(FORGOT_OTP_KEY) || '').trim(); } catch { return ''; }
  },
  clear() {
    try { localStorage.removeItem(FORGOT_OTP_KEY); } catch { /* private mode */ }
  },
};

/* Server ka asli message nikaalo — JSON ho ya plain text. */
function serverMessage(data, raw) {
  const msg =
    data?.message ?? data?.Message ?? data?.error ?? data?.title ??
    (typeof data === 'string' ? data : '') ?? '';
  return String(msg || raw || '').trim()
    .replace(/^(internal\s+server\s+error|bad\s+request|error)\s*:\s*/i, '').trim();
}

/* Method ke hisab se send-otp URL banata hai. Ab sirf PHONE flow backend se
   OTP mangwata hai — email flow Brevo se seedha bheja jata hai (neeche
   dekhein), is liye ab sirf phone endpoint yahan reh gaya hai. */
function buildSendOtpUrl(value) {
  return buildUrl(`/api/Auth/ERP-send-otp-forgetpassword?PhoneNumber=${encodeURIComponent(value)}`);
}

/* User exist karta hai ya nahi — /api/Auth/check_user_exists PURE koi OTP
   bheje bagair pehle hi check kar leta hai, taake ghalat/na-registered
   number ya email par bewajah OTP na jaye.
   Confirmed response shape: { "exists": boolean } — koi message field
   nahi aata, is liye generic "User not found" message khud dikhate hain. */
async function checkUserExists(identifierValue) {
  try {
    const res = await fetch(buildUrl('/api/Auth/check_user_exists'), {
      method: 'POST',
      headers: { 'Accept': '*/*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_Name: identifierValue, password: '' }),
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* plain-text */ }

    if (!res.ok || data?.exists === false) {
      return { exists: false };
    }
    return { exists: true };
  } catch (err) {
    /* Network fail ho to "user nahi mila" na bolein — asli wajah bata dein. */
    throw new Error(err?.message ? `Network error: ${err.message}` : 'Network error. Please try again.');
  }

}

/* ── Brevo (transactional email) — frontend se seedha bheja ja raha hai ──
   SECURITY NOTE: ye API key JS bundle me chali jati hai, is liye koi bhi
   browser devtools se nikaal sakta hai. Production ke liye is call ko
   backend proxy ke peeche rakhna behtar hoga; abhi ke liye jaisa mangwaya
   gaya hai waisa hi frontend-only implement kiya hai. */
/* Read from .env — see REACT_APP_BREVO_* in your project's .env file.
   Do NOT commit real values or paste them into chat; rotate immediately
   if a key is ever exposed. */
const BREVO_API_KEY = process.env.REACT_APP_BREVO_API_KEY;
const BREVO_SENDER   = {
  name:  process.env.REACT_APP_BREVO_SENDER_NAME  || 'SchoolMentor',
  email: process.env.REACT_APP_BREVO_SENDER_EMAIL || 'admin@schoolmentor.app',
};

/* 4-digit OTP generate karta hai — backend jaisa hi format (leading zero allowed). */
function generateOtp(length = OTP_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10);
  return out;
}

/* Brevo Transactional Email API (POST /v3/smtp/email) ko seedha call karta hai. */
async function sendOtpViaBrevo(toEmail, otp) {
  if (!BREVO_API_KEY) {
    throw new Error('Email sending is not configured. Missing REACT_APP_BREVO_API_KEY.');
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'api-key': BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: BREVO_SENDER,
      to: [{ email: toEmail }],
      subject: 'Your School Mentor password reset code',
      htmlContent: `
        <div style="font-family:sans-serif;font-size:15px;color:#111">
          <p>Your verification code is:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px">${otp}</p>
          <p>This code expires shortly. If you did not request this, you can ignore this email.</p>
        </div>`,
    }),
  });

  if (!res.ok) {
    let msg = 'Could not send the code. Please try again.';
    try {
      const data = await res.json();
      msg = data?.message || msg;
    } catch { /* non-JSON error body */ }
    throw new Error(msg);
  }
}

export default function ForgotPasswordScreen({ onBack }) {
  const [step,     setStep]     = useState('contact'); // contact -> otp -> reset -> done
  const [method,   setMethod]   = useState('phone');    // 'phone' | 'email'
  const [phone,    setPhone]    = useState('');
  const [email,    setEmail]    = useState('');
  const [otp,      setOtp]      = useState(Array(OTP_LENGTH).fill(''));
  const [sentOtp,  setSentOtp]  = useState('');
  const [password, setPassword] = useState('');
  const [confirm,  setConfirm]  = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState('');
  const [notice,   setNotice]   = useState('');
  const [busy,     setBusy]     = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [userNotFoundToast, setUserNotFoundToast] = useState(false);

  const otpRefs = useRef([]);

  /* Toast khud-ba-khud 3s me chala jata hai. */
  useEffect(() => {
    if (!userNotFoundToast) return;
    const id = setTimeout(() => setUserNotFoundToast(false), 3000);
    return () => clearTimeout(id);
  }, [userNotFoundToast]);

  /* Jo identifier abhi active hai (phone ya email), normalized/trimmed. */
  const identifier = method === 'phone'
    ? normalizePkPhone(phone).trim()
    : email.trim();

  /* Resend cooldown — har second ghatta hai. */
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  /* OTP step par pehle box me focus. */
  useEffect(() => {
    if (step === 'otp') otpRefs.current[0]?.focus();
  }, [step]);

  const sendOtp = useCallback(async (targetMethod, targetValue, isResend) => {
    const clean = targetMethod === 'phone'
      ? normalizePkPhone(targetValue).trim()
      : targetValue.trim();

    if (!clean) {
      setError(targetMethod === 'phone'
        ? 'Please enter your phone number.'
        : 'Please enter your email address.');
      return false;
    }
    if (targetMethod === 'email' && !EMAIL_RE.test(clean)) {
      setError('Please enter a valid email address.');
      return false;
    }

    setError(''); setNotice(''); setBusy(true);
    try {
      if (targetMethod === 'email') {
        /* Backend OTP nahi bhejta — yahin generate karke Brevo se seedha
           bhej dete hain, phir wahi localStorage verification path use
           hota hai jo phone flow me hai. */
        const freshOtp = generateOtp();
        await sendOtpViaBrevo(clean, freshOtp);
        setSentOtp(freshOtp);
        otpStore.save(freshOtp);
      } else {
        /* PhoneNumber query param me jata hai (body me nahi) — Swagger yahi
           kehta hai. Content-Length: 0 zaroori hai, warna IIS 411 de deta hai. */
        const res = await fetch(
          buildSendOtpUrl(clean),
          { method: 'POST', headers: { 'Accept': '*/*', 'Content-Length': '0' } },
        );
        const raw = await res.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { /* plain-text */ }

        if (!res.ok || data?.success === false) {
          /* Nayi OTP nahi mili to purani wali bhi hata do, warna wo match kar
             sakti thi aur user ghalat code se aage nikal jata. */
          otpStore.clear();
          setSentOtp('');
          setError(serverMessage(data, raw) || 'Could not send the code. Please try again.');
          return false;
        }

        if (data?.otp != null) {
          setSentOtp(String(data.otp));
          otpStore.save(data.otp);
        } else {
          otpStore.clear();
          setSentOtp('');
        }
      }

      setCooldown(RESEND_SECONDS);
      setOtp(Array(OTP_LENGTH).fill(''));
      if (isResend) setNotice(`A new code has been sent to your ${targetMethod === 'phone' ? 'phone' : 'email'}.`);
      return true;
    } catch (err) {
      /* sendOtpViaBrevo apna message throw karta hai (config missing / Brevo
         error) — us se seedha dikhaana behtar hai "Network error" se. */
      otpStore.clear();
      setSentOtp('');
      setError(err?.message || 'Network error. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  async function handleSendOtp() {
    const clean = method === 'phone'
      ? normalizePkPhone(phone).trim()
      : email.trim();

    if (!clean) {
      setError(method === 'phone'
        ? 'Please enter your phone number.'
        : 'Please enter your email address.');
      return;
    }
    if (method === 'email' && !EMAIL_RE.test(clean)) {
      setError('Please enter a valid email address.');
      return;
    }

    setError(''); setBusy(true);
    let check;
    try {
      check = await checkUserExists(clean);
    } catch (err) {
      setBusy(false);
      setError(err?.message || 'Network error. Please try again.');
      return;
    }
    setBusy(false);

    if (!check.exists) {
      setError('No account found with this ' + (method === 'phone' ? 'phone number.' : 'email address.'));
      setUserNotFoundToast(true);
      return;
    }

    if (await sendOtp(method, method === 'phone' ? phone : email, false)) setStep('otp');
  }

  function switchMethod(next) {
    if (next === method) return;
    setMethod(next);
    setError(''); setNotice('');
  }

  function handleOtpChange(i, value) {
    const digit = value.replace(/\D/g, '').slice(-1);
    setOtp((prev) => {
      const next = [...prev];
      next[i] = digit;
      return next;
    });
    setError('');
    if (digit && i < OTP_LENGTH - 1) otpRefs.current[i + 1]?.focus();
  }

  function handleOtpKeyDown(i, e) {
    if (e.key === 'Backspace' && !otp[i] && i > 0) otpRefs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft'  && i > 0) otpRefs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < OTP_LENGTH - 1) otpRefs.current[i + 1]?.focus();
    if (e.key === 'Enter') handleVerifyOtp();
  }

  /* Poora code ek saath paste karna — har box me ek digit. */
  function handleOtpPaste(e) {
    const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!digits) return;
    e.preventDefault();
    const next = Array(OTP_LENGTH).fill('');
    digits.split('').forEach((d, idx) => { next[idx] = d; });
    setOtp(next);
    otpRefs.current[Math.min(digits.length, OTP_LENGTH - 1)]?.focus();
  }

  function handleVerifyOtp() {
    const entered = otp.join('');
    if (entered.length < OTP_LENGTH) {
      setError(`Please enter all ${OTP_LENGTH} digits.`);
      return;
    }
    /* localStorage pehle — refresh ke baad state khali hoti hai magar saved OTP
       rehti hai, is liye user ko dobara code mangna nahi parta. */
    const saved = otpStore.read() || sentOtp;
    if (!saved) {
      setError('Your code has expired. Please request a new one.');
      return;
    }
    if (entered !== saved) {
      setError('That code is incorrect. Please check and try again.');
      return;
    }
    setError(''); setNotice('');
    setStep('reset');
  }

  async function handleResetPassword() {
    if (password.length < 6) {
      setError('Your new password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Both passwords must match.');
      return;
    }
    setError(''); setBusy(true);
    try {
      /* PUT /api/Auth/forget-password — ye identifier (`user_Name`) leta hai,
         userID nahi. Phone flow me yahan number jata tha; email flow me
         email jaayega — backend field generic hone ki assumption hai,
         confirm kar lein ke API dono accept karta hai. */
      const res = await fetch(buildUrl('/api/Auth/forget-password'), {
        method: 'PUT',
        headers: { 'Accept': '*/*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_Name: identifier,
          newPassword: password,
        }),
      });
      const raw = await res.text();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch { /* plain-text */ }

      if (!res.ok || data?.success === false) {
        setError(serverMessage(data, raw) || 'Could not update your password. Please try again.');
        return;
      }

      otpStore.clear();    // OTP apna kaam kar chuki — disk par chhorna bekaar
      setStep('done');
    } catch (err) {
      setError(err?.message ? `Network error: ${err.message}` : 'Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  /* Login par wapas jaate waqt saved OTP hata do — flow khatam ho chuka. */
  function leave() {
    otpStore.clear();
    onBack?.();
  }

  const otpFilled = otp.join('').length === OTP_LENGTH;

  /* ── heading / tagline har step ke hisab se ── */
  const otpDestination = method === 'phone'
    ? `+92 ${phone.replace(/^0/, '')}`
    : email;

  const HEADINGS = {
    contact: ['Forgot your password?',  'Choose how you would like to receive your verification code.'],
    otp:     ['Verify OTP', `Enter the ${OTP_LENGTH}-digit OTP sent to ${otpDestination}.`],
    reset:   ['Set a new password',      'Choose a strong password you have not used before.'],
    done:    ['Password updated',        'You can now sign in with your new password.'],
  };
  const [heading, tagline] = HEADINGS[step] || HEADINGS.contact;

  return (
    <AuthLayout illustration="login" heading={heading} tagline={tagline}>

      {error  && <div className="auth-error-box">{error}</div>}
      {notice && <div className="auth-success-card show">{notice}</div>}

      {userNotFoundToast && (
        <div className="auth-toast" role="status">
          <i className="fa-solid fa-circle-exclamation" />
          No account found with this {method === 'phone' ? 'phone number' : 'email address'}.
        </div>
      )}

      {/* ── STEP 1: contact (phone or email) ── */}
      {step === 'contact' && (
        <>
          <button type="button" className="auth-back-link" onClick={leave}>
            <i className="fa-solid fa-arrow-left" /> Back to sign in
          </button>

          {/* Sign-in method — same tab toggle as LoginScreen, instead of a dropdown */}
          <div className="auth-method-select">
            <button type="button"
              className={`auth-method-tab${method === 'phone' ? ' is-active' : ''}`}
              onClick={() => switchMethod('phone')}>
              <i className="fa-solid fa-phone" /> Phone Number
            </button>
            <button type="button"
              className={`auth-method-tab${method === 'email' ? ' is-active' : ''}`}
              onClick={() => switchMethod('email')}>
              <i className="fa-solid fa-envelope" /> Email
            </button>
          </div>

          {method === 'phone' ? (
            <>
              <label className="auth-label">Phone Number</label>
              <div className="auth-phone-row">
                <span className="auth-phone-code">+92</span>
                <div className="auth-input-wrap">
                  <input className="auth-input" type="tel" placeholder="3XX XXXXXXX"
                    value={phone}
                    onChange={(e) => setPhone(normalizePkPhone(e.target.value))}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendOtp()} />
                </div>
              </div>
            </>
          ) : (
            <>
              <label className="auth-label">Email Address</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon"><i className="fa-solid fa-envelope" /></span>
                <input className="auth-input" type="email" placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendOtp()} />
              </div>
            </>
          )}

          <button className="auth-btn-primary" onClick={handleSendOtp} disabled={busy}>
            {busy ? 'Sending…' : 'Send Verification Code'} <i className="fa-solid fa-arrow-right" />
          </button>
        </>
      )}

      {/* ── STEP 2: OTP ── */}
      {step === 'otp' && (
        <>
          <div className="auth-otp-row">
            {otp.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { otpRefs.current[i] = el; }}
                className={`auth-otp-box${digit ? ' filled' : ''}${error ? ' has-error' : ''}`}
                type="text" inputMode="numeric" autoComplete="one-time-code"
                maxLength={1} value={digit}
                onChange={(e) => handleOtpChange(i, e.target.value)}
                onKeyDown={(e) => handleOtpKeyDown(i, e)}
                onPaste={handleOtpPaste} />
            ))}
          </div>

          <div className="auth-resend-row">
            <button type="button" className="auth-resend-link"
              disabled={cooldown > 0 || busy}
              onClick={() => sendOtp(method, method === 'phone' ? phone : email, true)}>
              Resend OTP
            </button>
            {cooldown > 0 && (
              <span>Resend OTP in 00:{String(cooldown).padStart(2, '0')}</span>
            )}
          </div>

          <button className="auth-btn-primary" onClick={handleVerifyOtp} disabled={!otpFilled || busy}>
            Verify OTP <i className="fa-solid fa-arrow-right" />
          </button>

          {/* Verify button ke neeche — design ke mutabiq underlined link. */}
          <button type="button" className="auth-change-dest"
            onClick={() => { setStep('contact'); setError(''); setNotice(''); }}>
            {method === 'phone' ? 'Change Phone Number' : 'Change Email Address'}
          </button>
        </>
      )}

      {/* ── STEP 3: naya password ── */}
      {step === 'reset' && (
        <>
          <label className="auth-label">New Password</label>
          <div className="auth-input-wrap">
            <span className="auth-input-icon"><i className="fa-solid fa-lock" /></span>
            <input className="auth-input" type={showPass ? 'text' : 'password'}
              placeholder="Enter your new password"
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="auth-eye-btn" onClick={() => setShowPass((p) => !p)} tabIndex={-1}>
              <i className={`fa-solid ${showPass ? 'fa-eye-slash' : 'fa-eye'}`} />
            </button>
          </div>
          <p className="auth-pw-hint">Use at least 6 characters.</p>

          <label className="auth-label">Confirm New Password</label>
          <div className="auth-input-wrap">
            <span className="auth-input-icon"><i className="fa-solid fa-lock" /></span>
            <input className="auth-input" type={showPass ? 'text' : 'password'}
              placeholder="Re-enter your new password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleResetPassword()} />
          </div>

          <button className="auth-btn-primary" onClick={handleResetPassword} disabled={busy}>
            {busy ? 'Updating…' : 'Update Password'} <i className="fa-solid fa-arrow-right" />
          </button>
        </>
      )}

      {/* ── Success ── */}
      {step === 'done' && (
        <div className="auth-screen-center">
          <div className="auth-success-icon-wrap"><i className="fa-solid fa-check" /></div>
          <h3 className="auth-success-title">Password updated</h3>
          <p className="auth-success-sub">
            Your password has been changed. You can now sign in with your new password.
          </p>
          <button className="auth-btn-primary" onClick={leave}>
            Back to Sign In <i className="fa-solid fa-arrow-right" />
          </button>
        </div>
      )}

    </AuthLayout>
  );
}
