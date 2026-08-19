/* ════════════════════════════════════════════════════════════════════
   Support frontend configuration + runtime bridge.

   The Support module lives INSIDE SchoolMentor.API (same host, same JWT as the
   rest of the ERP) — it is no longer a standalone service with its own login.
   Endpoints hang off {erpBase}/api/support/... and the SignalR hub off
   {erpBase}/hubs/support. See README_ClaudeCode_Implementation §6.

   Where the values come from, in priority order:
     1. configureSupport({...}) — the host page injects apiBaseUrl / hub / token
        at runtime (ASP.NET MVC embed, or a future micro-frontend host).
     2. REACT_APP_SUPPORT_* env vars — only for pointing the CRA dev app at a
        local API instance.
     3. Support ka apna host + ERP ka session token. This is the normal in-app
        path: the user is already logged in, so Support never asks for
        credentials again.

   Base URL, dev vs prod:
     dev  → seedha https://alphaapi.schoolmentor.ai (Customer Support ka swagger
       wahin hai: /swagger/index.html). Support ka CORS caller ka Origin echo
       karta hai, is liye localhost se seedhi call chalti hai.
     prod → ERP ka apna origin (getBaseUrl), kyunki https page ke liye IIS
       /api/support/... ko usi API par forward karta hai — cross-origin jaane
       par CORS block kar deta hai. Dekho public/web.config.
     REACT_APP_SUPPORT_API set ho to wo dono par ghalib hai.

   The base URL / token are resolved lazily on every call because getBaseUrl()
   reads localStorage and the session token only appears after login.
   ════════════════════════════════════════════════════════════════════ */
import { getBaseUrl, MEDIA_BASE } from '../utils/apiConfig';

/* CRA (webpack 5) sirf poore `process.env` expression ko ek object literal se
   badalta hai — bare `process` browser bundle me maujood NAHI hota. Is liye
   `typeof process !== 'undefined'` production build me FALSE nikalta tha aur
   yeh poora object {} reh jata tha: NODE_ENV aur saare REACT_APP_* gayab.
   Isi wajah se prod build dev ka base (alphaapi) utha leta tha aur live par
   har support call CORS par mar jati thi. `process.env` seedha likhna hi
   theek hai — webpack use compile time par inline kar deta hai. */
const env = process.env || {};

/* Mutable runtime config. null → fall back to the ERP's own base / token. */
const cfg = {
  apiBaseUrl: env.REACT_APP_SUPPORT_API || null,
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

/* Customer Support API ka host — swagger: https://alphaapi.schoolmentor.ai/swagger/index.html */
const SUPPORT_DEV_API = 'https://alphaapi.schoolmentor.ai';

/** Host origin the Support API is served from. */
export function supportApiBase() {
  if (cfg.apiBaseUrl) return stripTrailingSlash(cfg.apiBaseUrl);
  /* prod me apna hi origin (IIS proxy), dev me seedha alphaapi. */
  return env.NODE_ENV === 'production'
    ? stripTrailingSlash(getBaseUrl())
    : SUPPORT_DEV_API;
}

/** Every Support REST route sits under this prefix. */
export const SUPPORT_API_PREFIX = '/api/support';

/** Absolute SignalR hub URL — {host}/hubs/support unless the host overrides it. */
export function supportHubUrl() {
  return cfg.hubUrl || `${supportApiBase()}/hubs/support`;
}

/* Support is always "enabled" now that it shares the ERP's host + token; when
   the API is unreachable the components fall back to offline demo behaviour. */
export const SUPPORT_BACKEND_ENABLED = true;

/**
 * Is the SignalR hub live?
 *
 * OFF by default: `app.MapHub<SupportHub>("/hubs/support")` (README §3) is not
 * deployed yet, so every connection attempt just fires a negotiate request that
 * 404s. With this off we never open the socket at all and useSupportChat polls
 * the open conversation instead — same result, no failing requests.
 *
 * Flip it on with REACT_APP_SUPPORT_REALTIME=true (or edit this default) the
 * day the hub ships; nothing else needs to change.
 */
export const SUPPORT_REALTIME_ENABLED = env.REACT_APP_SUPPORT_REALTIME === 'true';

const IDENTITY_KEYS = [
  'role', 'userId', 'schoolId', 'schoolName', 'campusName',
  'agentId', 'name', 'email', 'contactNumber',
];

/**
 * Apply host-supplied configuration at runtime. Called by the embed entry
 * points (window.SchoolMentorSupport*.init). Safe to call more than once.
 *
 *   configureSupport({
 *     apiBaseUrl, signalRHubUrl, token,
 *     role, userId, schoolId, schoolName, campusName, agentId, name, email, contactNumber
 *   })
 */
export function configureSupport(opts = {}) {
  if (opts.apiBaseUrl) cfg.apiBaseUrl = stripTrailingSlash(opts.apiBaseUrl);
  if (opts.signalRHubUrl) cfg.hubUrl = opts.signalRHubUrl;
  if (opts.token) cfg.token = opts.token;

  for (const k of IDENTITY_KEYS) {
    if (opts[k] != null) cfg.identity[k] = opts[k];
  }
  return { ...cfg };
}

const stripTrailingSlash = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : u);

const readSession = (key) => {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
};

/**
 * The JWT to send on Support calls. No Support-specific login exists: the ERP's
 * branch login already issues a token carrying the `BranchID` claim, which
 * SupportAuthHelper reads to identify the school user. A host-injected bridge
 * token (configureSupport) wins when present.
 */
export const getSupportToken = () => cfg.token || readSession('token');

/** Identity claims the host passed alongside the token (display only). */
export const getSupportIdentity = () => ({ ...cfg.identity });
/** True when a token is available at all — otherwise stay in offline demo mode. */
export const hasBridgeToken = () => Boolean(getSupportToken());

/** The caller's branch, used for the school-side history endpoints. */
export const getSupportSchoolId = () =>
  cfg.identity.schoolId || readSession('branchID') || null;

/**
 * The logged-in user's id, sent as `closedByAgentID` when a session is closed.
 * The ERP writes it to sessionStorage as `UserID` at login; a host-injected
 * identity (configureSupport) wins when present.
 */
export const getSupportUserId = () => {
  const id = cfg.identity.agentId || cfg.identity.userId || readSession('UserID');
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

/* Build an absolute URL for a stored attachment. The API saves uploads under
   its own wwwroot (/SupportAttachments/...) and returns that relative path, so
   it must be served from the MEDIA host — not the ERP origin, which has no
   rewrite rule for it (same reasoning as resolveMediaUrl in utils/apiConfig). */
export const fileUrl = (relativeOrAbsolute) => {
  if (!relativeOrAbsolute) return '';
  const u = String(relativeOrAbsolute).trim();
  if (u.startsWith('data:')) return u;
  /* The API stamps the URL from the request host, so it comes back as
     http://50.190.164.42:4100/SupportAttachments/... — plain http, which an
     https page blocks as mixed content, and localhost:4100 behind the IIS
     proxy. Keep the stored path, serve it from the media host. */
  const m = u.match(/\/SupportAttachments\/.*/i);
  if (m) return `${MEDIA_BASE}${m[0]}`;
  if (/^https?:\/\//i.test(u)) return u;
  return `${MEDIA_BASE}${u.startsWith('/') ? u : `/${u}`}`;
};
