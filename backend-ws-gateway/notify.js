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
      const deviceSnap = await firestoreDb.collection('devices').doc(deviceId).get();
      if (!deviceSnap.exists) return [];
      const device = deviceSnap.data() || {};
      const userIds = [...new Set([
        device.owner_id,
        ...(Array.isArray(device.member_ids) ? device.member_ids : []),
      ].filter(Boolean))];
      if (!userIds.length) return [];

      const tokenSnaps = await Promise.all(
        Array.from({ length: Math.ceil(userIds.length / 30) }, (_, index) =>
          firestoreDb.collection('fcm_tokens')
            .where('user_id', 'in', userIds.slice(index * 30, index * 30 + 30))
            .get()
        )
      );
      return tokenSnaps.flatMap((snap) => snap.docs
        .map((doc) => doc.data()?.token)
        .filter(Boolean));
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
