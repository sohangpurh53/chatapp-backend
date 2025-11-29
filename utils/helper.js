// backend/utils/helper.js

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // only if your Node version needs fetch

async function fcmPath(url) {
  try {
    if (!url) {
      throw new Error("No URL provided to fcmPath");
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    return json;
  } catch (error) {
    console.error("error while fetching fcm config:", error);
    return null;
  }
}

module.exports = fcmPath;
