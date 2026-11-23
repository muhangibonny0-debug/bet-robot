const fs = require('fs');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const file = 'out.json';
if (!fs.existsSync(file)) {
  console.log('Nothing to send');
  process.exit(0);
}
const list = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!list.length) {
  console.log('Nothing to send');
  process.exit(0);
}

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('The secret FIREBASE_SERVICE_ACCOUNT is missing or empty');
  process.exit(1);
}
let account;
try {
  account = JSON.parse(raw);
} catch (e) {
  console.error('The secret FIREBASE_SERVICE_ACCOUNT is not the full text of the Firebase key file');
  process.exit(1);
}

initializeApp({ credential: cert(account) });
const messaging = getMessaging();

(async () => {
  for (const n of list) {
    const payload = {
      topic: 'bet-assist',
      notification: { title: n.title, body: n.body },
      android: { priority: 'high' },
    };
    if (n.data && typeof n.data === 'object') {
      payload.data = Object.fromEntries(Object.entries(n.data).map(([k, v]) => [String(k), String(v)]));
    }
    await messaging.send(payload);
    console.log('Sent:', n.title);
  }
})().catch((e) => {
  console.error('Send failed:', e.message);
  process.exit(1);
});
