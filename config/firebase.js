const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();
const fcmPath = require('../utils/helper');

let messaging = null;

async function setupFirebase() {
  try {
    const fcmserviceAccountURL = process.env.FCM_SERVICE_ACCOUNT_URL;

    let serviceAccount = null;

    if (fcmserviceAccountURL) {
      // fetch JSON from URL
      serviceAccount = await fcmPath(fcmserviceAccountURL);
      
    }

    // fallback to local file if fetch failed
    if (!serviceAccount) {
      const localPath = path.join(__dirname, '../chatapp-488b1-firebase-adminsdk-fbsvc-ea441981de.json');
      serviceAccount = require(localPath);
    }

    // initialize firebase
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });

    messaging = admin.messaging();
    console.log("✅ Firebase Admin initialized");

  } catch (error) {
    console.warn("⚠️ Firebase Admin not initialized:", error.message);
  }
}

setupFirebase();

module.exports = { admin, messaging };
