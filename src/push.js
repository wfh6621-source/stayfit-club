// Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID), using only WebCrypto.
// build.py inlines this file into the worker (the "export" keywords are removed there).

const te = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// A new key pair for the club's push identity (stored once in the database).
export async function makeVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}

// One sender key per batch: each message still gets its own random salt, so keys differ per message.
export async function makeSenderKey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { priv: kp.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}

export async function encryptPayload(text, p256dh, auth, sender) {
  const ua = unb64u(p256dh), authSecret = unb64u(auth);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sender.priv, 256));
  const ikm = await hkdf(authSecret, shared, cat(te.encode('WebPush: info\0'), ua, sender.pub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(te.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return cat(salt, rs, new Uint8Array([sender.pub.length]), sender.pub, ct);
}

// Signed token telling the push service which club is sending. Cached per push service for an hour.
export async function vapidAuth(vapid, endpoint, subject, cache) {
  const aud = new URL(endpoint).origin;
  const hit = cache && cache[aud];
  if (hit && hit.exp > Date.now() / 1000 + 600) return hit.header;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const unsigned = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' + b64u(te.encode(JSON.stringify({ aud, exp, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(unsigned));
  const header = `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.pub}`;
  if (cache) cache[aud] = { exp, header };
  return header;
}

// Returns 'ok', 'gone' (subscription no longer valid; delete it) or 'fail'.
export async function sendPush(sub, message, vapid, subject, sender, cache) {
  try {
    const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth, sender);
    const r = await fetch(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidAuth(vapid, sub.endpoint, subject, cache), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
      body
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'fail';
  } catch (e) { return 'fail'; }
}
