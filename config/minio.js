const Minio = require('minio');

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'chatapp-media';

// Client used only for signing download URLs against the public MinIO host
// (MINIO_PUBLIC_URL), so links handed out don't point at the internal endpoint.
// Region is fixed so presigning doesn't need a network round-trip.
let publicMinioClient = minioClient;
if (process.env.MINIO_PUBLIC_URL) {
  const publicUrl = new URL(process.env.MINIO_PUBLIC_URL);
  const useSSL = publicUrl.protocol === 'https:';
  publicMinioClient = new Minio.Client({
    endPoint: publicUrl.hostname,
    port: publicUrl.port ? parseInt(publicUrl.port) : (useSSL ? 443 : 80),
    useSSL,
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    region: process.env.MINIO_REGION || 'us-east-1',
  });
}

// Presigned GET URL on the public host
function presignedPublicUrl(bucket, objectName, expirySeconds) {
  return publicMinioClient.presignedGetObject(bucket, objectName, expirySeconds);
}

// Initialize bucket
async function initializeBucket() {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
      console.log(`✅ MinIO bucket '${BUCKET_NAME}' created successfully`);
      
      // Set bucket policy for public read access
      const policy = {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`]
        }]
      };
      
      await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(policy));
      console.log(`✅ MinIO bucket policy set for public read access`);
    } else {
      console.log(`✅ MinIO bucket '${BUCKET_NAME}' already exists`);
    }
  } catch (error) {
    console.error('❌ MinIO initialization error:', error.message);
    console.warn('⚠️  MinIO not available - file uploads will not work');
    console.warn('⚠️  To enable file uploads, ensure MinIO is running and configured');
  }
}

// Test MinIO connection
async function testConnection() {
  try {
    await minioClient.listBuckets();
    console.log('✅ MinIO connection successful');
    return true;
  } catch (error) {
    console.error('❌ MinIO connection failed:', error.message);
    return false;
  }
}

module.exports = {
  minioClient,
  BUCKET_NAME,
  presignedPublicUrl,
  initializeBucket,
  testConnection
};
