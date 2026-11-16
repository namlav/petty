/**
 * [SV3: T-SV3-03 | SV2: T-SV2-04] Xác thực JWT & RBAC (Firebase Auth + HS256 demo)
 *
 * Hỗ trợ:
 *  - Firebase ID Token (verifyIdToken qua firebase-admin Auth) + tra role trong Firestore `users/{uid}`
 *  - JWT cục bộ HS256 (JWT_SECRET) cho demo/test
 *  - Chế độ demo khi NODE_ENV=development và chưa cấu hình Firebase Auth hay JWT_SECRET
 *  - Xác thực thiết bị qua header Authorization: Bearer <token> (ưu tiên) hoặc query ?token= (dev)
 */
'use strict';

const crypto = require('crypto');

const base64url = (value) => Buffer.from(value).toString('base64url');

function verifyHmacJwt(token, secret) {
  if (!token || !secret) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, body, signature] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

function createAuthHelpers({
  firebaseAuth = null,
  firestoreDb = null,
  jwtSecret = process.env.JWT_SECRET || '',
  deviceToken = process.env.DEVICE_TOKEN || 'dev-device-token',
  nodeEnv = process.env.NODE_ENV || 'development',
} = {}) {
  const isDev = nodeEnv === 'development';
  const roleCache = new Map(); // uid -> { role, expiresAt }
  const ROLE_CACHE_TTL_MS = 60_000;

  function signToken(payload, expiresInSeconds = 3600) {
    if (!jwtSecret) {
      return '';
    }
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64url(
      JSON.stringify({
        ...payload,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      })
    );
    const signature = crypto
      .createHmac('sha256', jwtSecret)
      .update(`${header}.${body}`)
      .digest('base64url');
    return `${header}.${body}.${signature}`;
  }

  async function resolveFirebaseRole(decoded) {
    if (decoded.role && ['admin', 'owner', 'viewer', 'device'].includes(decoded.role)) {
      return decoded.role;
    }
    if (!firestoreDb || !decoded.uid) {
      return 'viewer';
    }
    const cached = roleCache.get(decoded.uid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.role;
    }
    try {
      const snap = await firestoreDb.collection('users').doc(decoded.uid).get();
      const role = snap.exists ? snap.data()?.role || 'viewer' : 'viewer';
      roleCache.set(decoded.uid, { role, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
      return role;
    } catch (error) {
      console.warn('[AUTH] Không đọc được Firestore users/{uid}:', error.message);
      return 'viewer';
    }
  }

  async function verifyTokenAsync(token) {
    // Trong development khi chưa đặt JWT_SECRET: cho phép bỏ trống token để chạy chế độ demo.
    if (!token) {
      return isDev && !jwtSecret ? { role: 'admin', sub: 'demo' } : null;
    }

    // Chưa cấu hình cả Firebase Auth lẫn JWT_SECRET trong development => fallback demo admin.
    if (!firebaseAuth && !jwtSecret) {
      return isDev ? { role: 'admin', sub: 'demo' } : null;
    }

    // 1) Ưu tiên xác thực Firebase ID Token nếu firebase-admin Auth đang bật
    if (firebaseAuth) {
      try {
        const decoded = await firebaseAuth.verifyIdToken(token);
        const role = await resolveFirebaseRole(decoded);
        return {
          ...decoded,
          sub: decoded.uid,
          role,
          isFirebase: true,
        };
      } catch {
        // Thử fallback sang JWT_SECRET cục bộ nếu có cấu hình song song cho dev
      }
    }

    // 2) Fallback sang JWT_SECRET cục bộ (demo token in lúc khởi động)
    if (jwtSecret) {
      return verifyHmacJwt(token, jwtSecret);
    }

    return null;
  }

  function verifyToken(token) {
    if (!token) {
      return isDev && !jwtSecret ? { role: 'admin', sub: 'demo' } : null;
    }
    if (!firebaseAuth && !jwtSecret) {
      return isDev ? { role: 'admin', sub: 'demo' } : null;
    }
    return verifyHmacJwt(token, jwtSecret);
  }

  function extractBearerToken(request) {
    const header = request?.headers?.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    return match ? match[1].trim() : '';
  }

  async function deviceAuthorized(requestOrToken, queryToken = '', requestedDeviceId = '') {
    let headerToken = '';
    let fallbackQuery = queryToken;
    let deviceId = requestedDeviceId;
    let headerDeviceId = '';
    if (typeof requestOrToken === 'string') {
      fallbackQuery = requestOrToken;
    } else if (requestOrToken && requestOrToken.headers) {
      headerToken = extractBearerToken(requestOrToken);
      headerDeviceId = String(requestOrToken.headers['x-device-id'] || '').trim();
      deviceId = headerDeviceId || deviceId;
    }

    // Production identity must come entirely from headers; URL credentials and IDs
    // can be copied into proxy/access logs and are never accepted as device identity.
    if (!isDev && (!headerToken || !headerDeviceId)) return false;
    const candidate = headerToken || (isDev ? fallbackQuery : '');
    if (!candidate) {
      return false;
    }
    if (isDev && candidate === deviceToken) {
      return true;
    }
    if (isDev) {
      const claims = verifyToken(candidate);
      if (claims?.role === 'device') return true;
    }

    if (isDev || !firestoreDb || !deviceId || deviceId.includes('/')) {
      return false;
    }
    try {
      const snap = await firestoreDb.collection('device_credentials').doc(deviceId).get();
      const expectedHash = String(snap.data()?.token_hash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
      const actualHash = crypto.createHash('sha256').update(candidate).digest();
      const expected = Buffer.from(expectedHash, 'hex');
      return actualHash.length === expected.length && crypto.timingSafeEqual(actualHash, expected);
    } catch (error) {
      console.warn('[AUTH] Không xác minh được device_credentials:', error.message);
      return false;
    }
  }

  function auth(allowedRoles) {
    return async (req, res, next) => {
      const token = extractBearerToken(req);
      const claims = await verifyTokenAsync(token);
      if (!claims) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      if (allowedRoles && !allowedRoles.includes(claims.role)) {
        return res.status(403).json({ error: 'forbidden', role: claims.role });
      }
      req.user = claims;
      return next();
    };
  }

  return {
    signToken,
    verifyToken,
    verifyTokenAsync,
    deviceAuthorized,
    auth,
    hasAuthConfigured: Boolean(firebaseAuth || jwtSecret),
  };
}

module.exports = { createAuthHelpers };
