/**
 * [SV3] Khởi tạo Firebase Admin SDK (Firestore + Auth + FCM)
 *
 * Dùng chung 1 file Service Account JSON (từ Firebase Console -> Service Accounts)
 * cho cả 3 dịch vụ miễn phí trên gói Spark:
 *  - Cloud Firestore (admin.firestore())
 *  - Firebase Authentication JWT verify (admin.auth())
 *  - Firebase Cloud Messaging (admin.messaging())
 *
 * Nếu chưa có file Service Account hoặc chưa cài `firebase-admin`,
 * gateway tự động chạy chế độ in-memory / demo mà không bị lỗi.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function initFirebase({
  serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || '',
  projectId = process.env.FIREBASE_PROJECT_ID || '',
} = {}) {
  const empty = {
    isFirebaseEnabled: false,
    admin: null,
    db: null,
    auth: null,
    messaging: null,
  };

  if (!serviceAccountPath) {
    return empty;
  }

  const resolved = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.join(__dirname, serviceAccountPath);

  if (!fs.existsSync(resolved)) {
    return empty;
  }

  try {
    // firebase-admin v14+ sử dụng modular subpath exports (firebase-admin/*)
    // eslint-disable-next-line global-require
    const { initializeApp, getApps, cert } = require('firebase-admin/app');
    // eslint-disable-next-line global-require
    const { getFirestore, FieldValue } = require('firebase-admin/firestore');
    // eslint-disable-next-line global-require
    const { getAuth } = require('firebase-admin/auth');
    // eslint-disable-next-line global-require
    const { getMessaging } = require('firebase-admin/messaging');

    const serviceAccount = JSON.parse(fs.readFileSync(resolved, 'utf8'));

    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount),
        ...(projectId ? { projectId } : {}),
      });
    }

    return {
      isFirebaseEnabled: true,
      admin: { firestore: { FieldValue } },
      db: getFirestore(),
      auth: getAuth(),
      messaging: getMessaging(),
    };
  } catch (error) {
    console.warn(
      `[FIREBASE] Không khởi tạo được firebase-admin (${error.message}), chuyển sang chế độ demo in-memory`
    );
    return empty;
  }
}

module.exports = { initFirebase };
