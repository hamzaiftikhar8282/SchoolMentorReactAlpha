/* ════════════════════════════════════════════════════════════════════
   Support frontend configuration + runtime bridge — SUPER ADMIN (agent) side.

   The Support module lives INSIDE SchoolMentor.API (same host as the rest of
   the ERP), not in a standalone service any more: endpoints hang off
   {apiHost}/api/support/... and the SignalR hub off {apiHost}/hubs/support.
   There is no Support login — the console's own JWT (sessionStorage
   `superadmintoken`, written by SuperAdminLogin) is what identifies the agent.
   The API reads its claims: a `BranchID` claim means "school user", anything
   else is an agent/super-admin, and the agent's own id comes off the
   nameidentifier claim (that is what /agents/me/assigned resolves).

   Where the values come from, in priority order:
     1. configureSupport({...}) — a host page injecting apiBaseUrl / hub / token
        at runtime (the .NET MVC embed).
     2. REACT_APP_SUPPORT_* env vars — for pointing the CRA dev app somewhere
        else.
     3. The defaults below + the console's own session token.

   Base URL, dev vs prod (faisla RUNTIME par hostname se — niche
   defaultApiBase() dekho, NODE_ENV par bharosa nahi):
     dev  (npm start on localhost:3001) → API host directly:
       https://alphaapi.schoolmentor.ai (swagger /swagger/index.html par).
       Uski CORS allow-list me localhost:3001 hai, is liye proxy nahi chahiye.
     prod (kisi bhi deployed host, e.g. https://admin.schoolmentor.ai)
       → OWN origin (empty base). alphaapi ki allow-list me ye origin NAHI hai
       (jawab me koi Access-Control-Allow-Origin nahi → CORS error), aur https
       page http API ko bhi call nahi kar sakta. Is liye IIS same-origin
       /api/... ko API par reverse-proxy karta hai — public/web.config ka
       "API Proxy" rule (ARR "Enable proxy" + URL Rewrite chahiye).
       Verify: curl https://admin.schoolmentor.ai/api/support/sessions → 200.

   The base URL / token are resolved lazily on every call because the session
   token only appears after login.
   ════════════════════════════════════════════════════════════════════ */

/* CRA (webpack 5) sirf poore `process.env` expression ko ek object literal se
   badalta hai — bare `process` browser bundle me maujood NAHI hota. Is liye
   `typeof process !== 'undefined'` production build me FALSE nikalta tha aur
   yeh poora object {} reh jata tha: NODE_ENV aur saare REACT_APP_* gayab.
   Isi wajah se prod build dev ka base (alphaapi) utha leta tha aur live par
   har support call CORS par mar jati thi. `process.env` seedha likhna hi
   theek hai — webpack use compile time par inline kar deta hai. */
const env = process.env || {};

const stripTrailingSlash = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : u);

/* Host the Support API is served from. '' → this app's own origin.
   Dev me seedha alphaapi — Customer Support ka swagger wahin hai:
   https://alphaapi.schoolmentor.ai/swagger/index.html */
const DEV_API_BASE = 'https://alphaapi.schoolmentor.ai';
const PROD_API_BASE = '';

/* Kya hum dev machine par chal rahe hain?

   Base ka faisla NODE_ENV ke bharose par NAHI chhorte. alphaapi ki CORS ek
   fixed allow-list hai — http://localhost:3001 allowed hai, magar
   https://admin.schoolmentor.ai NAHI (uske jawab me koi
   Access-Control-Allow-Origin header hi nahi aata). Is liye jis build me
   env inline na ho — ya jab app kisi host page me embed ho — wahan prod
   bundle alphaapi ko cross-origin call karta hai aur HAR support request
   CORS par mar jati hai. Hostname runtime par hamesha sach bolta hai:
   localhost = dev (seedha alphaapi), koi bhi deployed host = apna origin +
   IIS rewrite (web.config ka "API Proxy" rule). */
const isLocalhostOrigin = () => {
  try {
    return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(window.location.hostname);
  } catch (e) {
    return false;                       // koi window nahi (SSR/test) → deployed maan lo
  }
};

const defaultApiBase = () => {
  if (env.REACT_APP_SUPPORT_API) return stripTrailingSlash(env.REACT_APP_SUPPORT_API);
  return isLocalhostOrigin() ? DEV_API_BASE : PROD_API_BASE;
};

/* Mutable runtime config. null → fall back to the defaults / session token. */
const cfg = {
  apiBaseUrl: null,
  hubUrl: env.REACT_APP_SUPPORT_HUB || null,   // null → derived from apiBaseUrl
  token: env.REACT_APP_SUPPORT_TOKEN || null,  // bridge JWT from the host app
  identity: {
    role: null,        // 'SchoolUser' | 'Agent' | 'SuperAdmin'
    userId: null,
    schoolId: null,
    schoolName: null,
    campusName: null,
    agentId: null,
    name: null,
    email: null,
    contactNumber: null,
  },
};

/** Host origin the Support API is served from. */
export function supportApiBase() {
  return cfg.apiBaseUrl != null ? cfg.apiBaseUrl : defaultApiBase();
}

/** Every Support REST route sits under this prefix. */
export const SUPPORT_API_PREFIX = '/api/support';

/** Absolute SignalR hub URL — {host}/hubs/support unless the host overrides it. */
export function supportHubUrl() {
  return cfg.hubUrl || `${supportApiBase()}/hubs/support`;
}

/* Support is always "enabled" now that it shares the ERP API host + token; when
   the API is unreachable the components fall back to offline demo behaviour. */
export const SUPPORT_BACKEND_ENABLED = true;

/**
 * Is the SignalR hub live?
 *
 * OFF by default, exactly as on the school side: `app.MapHub<SupportHub>
 * ("/hubs/support")` is not deployed yet, so every attempt just fires a
 * negotiate request that 404s. With this off no socket is opened at all and
 * useSupportChat polls the open conversation instead. Note that the super-admin
 * site's web.config has no /hubs rewrite either — add one before flipping this
 * on for a production build.
 *
 * Turn it on with REACT_APP_SUPPORT_REALTIME=true the day the hub ships.
 */
export const SUPPORT_REALTIME_ENABLED = env.REACT_APP_SUPPORT_REALTIME === 'true';

const IDENTITY_KEYS = [
  'role', 'userId', 'schoolId', 'schoolName', 'campusName',
  'agentId', 'name', 'email', 'contactNumber',
];

/**
 * Apply host-supplied configuration at runtime. Called by the embed entry
 * point (window.SchoolMentorSupportAdmin.init). Safe to call more than once.
 *
 *   configureSupport({
 *     apiBaseUrl, signalRHubUrl, token,
 *     role, userId, schoolId, schoolName, campusName, agentId, name, email, contactNumber
 *   })
 */
export function configureSupport(opts = {}) {
  if (opts.apiBaseUrl != null) cfg.apiBaseUrl = stripTrailingSlash(opts.apiBaseUrl);
  if (opts.signalRHubUrl) cfg.hubUrl = opts.signalRHubUrl;
  if (opts.token) cfg.token = opts.token;

  for (const k of IDENTITY_KEYS) {
    if (opts[k] != null) cfg.identity[k] = opts[k];
  }
  return { ...cfg };
}

const readSession = (key) => {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
};

/**
 * The JWT to send on Support calls. The Super Admin console's own login stores
 * it as `superadmintoken` (SA_SESSION_KEYS.token in superadmin/api/services/auth).
 * A host-injected bridge token (configureSupport) wins when present.
 */
export const getSupportToken = () => cfg.token || readSession('superadmintoken');

/** Identity claims the host passed alongside the token (display only). */
export const getSupportIdentity = () => ({ ...cfg.identity });
/** True when a token is available at all — otherwise stay in offline demo mode. */
export const hasBridgeToken = () => Boolean(getSupportToken());

/** Only meaningful on the school side; kept so the shared hook stays identical. */
export const getSupportSchoolId = () => cfg.identity.schoolId || null;

/**
 * The logged-in agent's id, sent as `closedByAgentID` when a session is closed.
 * The console writes it to sessionStorage as `superadminid` at login — the same
 * id the /support/agents list is keyed by.
 */
export const getSupportUserId = () => {
  const id = cfg.identity.agentId || cfg.identity.userId || readSession('superadminid');
  if (id == null || id === '') return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
};

/* Backend enum values (mirror SchoolMentor.Support.Domain.Enums). */
export const SenderType = { School: 1, Agent: 2 };
export const MessageStatus = { Sent: 1, Delivered: 2, Read: 3 };
export const SessionStatus = { Open: 1, Closed: 2 };
export const UserRole = { SchoolUser: 1, Agent: 2, SuperAdmin: 3 };
export const MessageType = {
  Text: 1, Image: 2, Document: 3, Pdf: 4, VoiceNote: 5, Video: 6, Screenshot: 7,
};

/* Max files per single send, by category (frontend-enforced). */
export const ATTACH_LIMITS = { image: 10, document: 10, video: 5 };

/* Voice note ke saath jane wala tay-shuda caption.
   Upload route par `caption` [Required] hai (khali par 400 "The caption field
   is required") aur voice bubble me user ka apna koi matn hota hi nahi — is
   liye ye bhejte hain. Sirf API ki shart poori karne ke liye hai, is liye
   chat me dikhaya NAHI jata: toUi voice message ka body isi se milata hai aur
   barabar ho to text gira deta hai. */
export const VOICE_NOTE_CAPTION = 'Voice note';

/* Uploaded attachments live in the API's own wwwroot (/SupportAttachments/...)
   and come back stamped with whatever host served the request — the IP on :4100
   (blocked as mixed content from an https page) or localhost:4100 behind the
   proxy (nothing there in the user's browser). Keep the stored path, serve it
   from the media host. Same reasoning as the school-side copy. */
export const MEDIA_BASE = stripTrailingSlash(
  env.REACT_APP_MEDIA_BASE || 'https://alphaapi.schoolmentor.ai',
);

export const fileUrl = (relativeOrAbsolute) => {
  if (!relativeOrAbsolute) return '';
  const u = String(relativeOrAbsolute).trim();
  if (u.startsWith('data:')) return u;
  const m = u.match(/\/SupportAttachments\/.*/i);
  if (m) return `${MEDIA_BASE}${m[0]}`;
  if (/^https?:\/\//i.test(u)) return u;
  return `${MEDIA_BASE}${u.startsWith('/') ? u : `/${u}`}`;
};
