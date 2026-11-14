const fs = require('fs');
const admin = require('firebase-admin');

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

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});

(async () => {
  for (const n of list) {
    await admin.messaging().send({
      topic: 'bet-assist',
      notification: { title: n.title, body: n.body },
      android: { priority: 'high' },
    });
    console.log('Sent:', n.title);
  }
})().catch((e) => {
  console.error('Send failed:', e.message);
  process.exit(1);
});
