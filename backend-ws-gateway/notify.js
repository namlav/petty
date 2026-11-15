/**
 * [SV3: T-SV3-04] Firebase Cloud Messaging (FCM) Notifier (100% Firebase)
 *
 * Chế độ hoạt động:
 *  - Nếu chưa khởi tạo được firebase-admin messaging (thiếu Service Account):
 *    chạy ở chế độ demo (log [FCM:DEMO], không crash gateway).
 *  - Khi cấu hình đủ: lấy fcm_tokens từ Cloud Firestore và gửi multicast qua FCM HTTP v1.
 */
'use strict';

function createNotifier({ firestoreDb = null, messaging = null } = {}) {
  const mode = messaging ? 'fcm' : 'demo';

  async function fetchDeviceTokens(deviceId) {
    if (!firestoreDb) {
      return [];
    }
    try {
      // TODO(T-SV3-04): Đọc devices/{deviceId} để chỉ gửi tới owner_id + member_ids.
      const deviceSnap = await firestoreDb.collection('devices').doc(deviceId).get();
      let allowedUserIds = null;
      if (deviceSnap.exists) {
        const d = deviceSnap.data() || {};
        const ids = [d.owner_id, ...(Array.isArray(d.member_ids) ? d.member_ids : [])].filter(
          Boolean
        );
        if (ids.length > 0) {
          allowedUserIds = new Set(ids);
        }
      }

      const snap = await firestoreDb.collection('fcm_tokens').get();
      const tokens = [];
      snap.forEach((doc) => {
        const data = doc.data() || {};
        if (!data.token) return;
        if (!allowedUserIds || allowedUserIds.has(data.user_id)) {
          tokens.push(data.token);
        }
      });
      return tokens;
    } catch (error) {
      console.error('[FCM] Lỗi đọc fcm_tokens từ Firestore:', error.message);
      return [];
    }
  }

  async function removeInvalidTokens(tokens) {
    if (!firestoreDb || !tokens.length) return;
    await Promise.all(
      tokens.map((token) =>
        firestoreDb
          .collection('fcm_tokens')
          .doc(token)
          .delete()
          .catch(() => {})
      )
    );
  }

  async function sendAlertPush(alert) {
    if (!messaging) {
      console.log(`[FCM:DEMO] ${alert.device_id} [${alert.kind}] ${alert.message}`);
      return { ok: true, mode: 'demo', sent: 0 };
    }

    const tokens = await fetchDeviceTokens(alert.device_id);
    if (!tokens.length) {
      return { ok: true, mode: 'fcm', sent: 0 };
    }

    const result = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: `Petty · ${alert.kind}`,
        body: alert.message,
      },
      data: {
        device_id: String(alert.device_id),
        kind: String(alert.kind),
        alert_id: String(alert.id || ''),
      },
    });

    const invalid = [];
    result.responses.forEach((resp, idx) => {
      if (
        !resp.success &&
        resp.error?.code === 'messaging/registration-token-not-registered'
      ) {
        invalid.push(tokens[idx]);
      }
    });
    if (invalid.length) {
      await removeInvalidTokens(invalid);
    }

    return { ok: true, mode: 'fcm', sent: result.successCount };
  }

  async function upsertFcmToken({ userId, token, platform }) {
    if (!token || !platform) {
      return { ok: false, error: 'missing token or platform' };
    }
    if (!firestoreDb) {
      console.log(`[FCM:DEMO] Đăng ký token (${platform}) cho user=${userId}`);
      return { ok: true, mode: 'demo' };
    }
    try {
      await firestoreDb.collection('fcm_tokens').doc(token).set(
        {
          token,
          user_id: userId,
          platform,
          updated_at: new Date().toISOString(),
        },
        { merge: true }
      );
      return { ok: true, mode: 'firestore' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  return {
    mode,
    sendAlertPush,
    upsertFcmToken,
  };
}

module.exports = { createNotifier };
