const Minio = require('minio');

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'chatapp-media';

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
  initializeBucket,
  testConnection
};
