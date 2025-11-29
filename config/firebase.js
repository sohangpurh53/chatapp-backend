const admin = require('firebase-admin');
const path = require('path');

let messaging = null;

try {
  // Check if Firebase service account file exists
  const serviceAccountPath = path.join(__dirname, '../chatapp-488b1-firebase-adminsdk-fbsvc-ea441981de.json');
  
  // Try to load service account
  const serviceAccount = require(serviceAccountPath);
  
  // Initialize Firebase Admin SDK
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
  
  messaging = admin.messaging();
  
  console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
  console.warn('⚠️  Firebase Admin SDK not initialized:', error.message);
  console.warn('⚠️  Push notifications will not work until Firebase is configured');
  console.warn('⚠️  To enable push notifications:');
  console.warn('   1. Download firebase-service-account.json from Firebase Console');
  console.warn('   2. Place it in backend/ directory');
  console.warn('   3. Set FIREBASE_PROJECT_ID in .env file');
  console.warn('   4. Restart the server');
}

module.exports = { admin, messaging };
