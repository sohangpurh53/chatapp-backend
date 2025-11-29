const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();
const fcmPath = require('../utils/helper');

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

    console.log("✅ Firebase Admin initialized");
    return admin.messaging();

  } catch (error) {
    console.warn("⚠️ Firebase Admin not initialized:", error.message);
    return null;
  }
}

// Initialize and export as a getter function
let messagingInstance = null;
const messagingPromise = setupFirebase().then(instance => {
  messagingInstance = instance;
  return instance;
});

// Export getter function that returns the messaging instance
const getMessaging = () => messagingInstance;

module.exports = { admin, getMessaging, messagingPromise };
