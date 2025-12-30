# APK Upload System

A secure APK file upload system with 64-bit encrypted key authentication and MinIO storage.

## 🔐 Security Features

- **64-bit Encrypted Key Authentication**: Dual-key verification system
- **Timing-Safe Comparison**: Prevents timing attacks
- **File Type Validation**: Only APK files allowed
- **Size Limits**: 100MB maximum file size
- **Secure Headers**: Custom authentication header

## 🚀 Setup

### 1. Generate Secure Key

```bash
cd backend
npm run generate-apk-key
```

This will generate a secure 64-bit key. Copy the output to your environment files.

### 2. Environment Configuration

Add to `backend/.env`:
```env
APK_UPLOAD_SECRET_KEY=your_generated_key_here
```

Add to your upload script environment:
```env
APK_UPLOAD_KEY=your_generated_key_here
UPLOAD_API_URL=http://localhost:3000/api/apk/upload
```

### 3. Start the Server

```bash
cd backend
npm start
```

## 📡 API Endpoints

### Upload APK
```http
POST /api/apk/upload
Content-Type: multipart/form-data
x-apk-upload-key: your_64_bit_key

Body:
- file: APK file
- type: Upload type (e.g., "android-release")
```

### List APK Files
```http
GET /api/apk/list
x-apk-upload-key: your_64_bit_key
```

### Download APK
```http
GET /api/apk/download/:filename
x-apk-upload-key: your_64_bit_key
```

### Health Check
```http
GET /api/apk/health
```

## 🧪 Testing

### Run All Tests
```bash
cd backend
npm run test-apk-upload
```

### Manual Testing with cURL

```bash
# Health check (no auth required)
curl http://localhost:3000/api/apk/health

# Upload APK (requires auth)
curl -X POST \
  -H "x-apk-upload-key: YOUR_KEY_HERE" \
  -F "file=@path/to/your/app.apk" \
  -F "type=android-release" \
  http://localhost:3000/api/apk/upload

# List APK files (requires auth)
curl -H "x-apk-upload-key: YOUR_KEY_HERE" \
  http://localhost:3000/api/apk/list
```

## 📱 Upload Script Usage

The updated `ChatApp/scripts/upload-build.mjs` now supports the secure endpoint:

```bash
cd ChatApp
export APK_UPLOAD_KEY="your_key_here"
export UPLOAD_API_URL="http://localhost:3000/api/apk/upload"
node scripts/upload-build.mjs ./android/app/build/outputs/apk/release/
```

## 🗂️ File Structure

```
backend/
├── routes/apk.js              # APK upload routes
├── utils/apkUploadHelper.js   # Helper utilities
├── scripts/generate-apk-key.js # Key generation script
├── test-apk-upload.js         # Test suite
└── APK_UPLOAD_README.md       # This documentation
```

## 🔧 Configuration Options

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `APK_UPLOAD_SECRET_KEY` | 64-bit server key | Required |
| `MINIO_BUCKET` | MinIO bucket name | `chatapp-media` |
| `UPLOAD_API_URL` | Upload endpoint URL | `http://localhost:3000/api/apk/upload` |
| `APK_UPLOAD_KEY` | Client upload key | Required for uploads |

### File Limits

- **Maximum Size**: 100MB
- **Minimum Size**: 1MB
- **File Types**: `.apk` files only
- **MIME Types**: `application/vnd.android.package-archive`, `application/octet-stream`

## 🛡️ Security Implementation

### Key Verification Process

1. Client sends key in `x-apk-upload-key` header
2. Server compares with `APK_UPLOAD_SECRET_KEY` from environment
3. Both keys are hashed using SHA-256
4. Timing-safe comparison prevents timing attacks
5. Access granted only on exact match

### File Validation

1. File extension must be `.apk`
2. MIME type validation
3. Size limits enforced
4. Buffer validation for security

## 📊 Response Format

### Success Response
```json
{
  "success": true,
  "message": "APK uploaded successfully",
  "data": {
    "filename": "android-release-v1.0.0-2024-12-30T10-30-00-000Z.apk",
    "objectName": "apk-builds/android-release-v1.0.0-2024-12-30T10-30-00-000Z.apk",
    "size": 25165824,
    "sizeFormatted": "24.00 MB",
    "uploadType": "android-release",
    "downloadUrl": "https://minio.example.com/...",
    "uploadedAt": "2024-12-30T10:30:00.000Z"
  }
}
```

### Error Response
```json
{
  "success": false,
  "error": "Invalid APK upload authorization key"
}
```

## 🔄 Integration with Build Process

The system integrates with your existing build process:

1. **Build APK**: `./gradlew assembleRelease`
2. **Upload APK**: Script automatically uploads with secure key
3. **Store in MinIO**: Files stored with metadata
4. **Generate URLs**: Presigned URLs for downloads

## 🚨 Troubleshooting

### Common Issues

1. **401 Unauthorized**: Missing `x-apk-upload-key` header
2. **403 Forbidden**: Invalid key or key mismatch
3. **400 Bad Request**: Invalid file type or size
4. **500 Server Error**: MinIO connection or server configuration

### Debug Steps

1. Check environment variables are set
2. Verify MinIO is running and accessible
3. Test with health endpoint first
4. Run the test suite for comprehensive checks

## 📝 Logs

The system provides detailed logging:

```
✅ APK uploaded successfully: apk-builds/android-release-2024-12-30.apk (24.00 MB)
❌ APK upload auth verification error: Invalid key
🔐 APK upload key verification: SUCCESS
```

## 🔮 Future Enhancements

- [ ] APK signature verification
- [ ] Version management and rollback
- [ ] Automated testing integration
- [ ] Build artifact metadata extraction
- [ ] Integration with CI/CD pipelines
- [ ] Multi-environment support (dev/staging/prod)

---

**Security Note**: Always keep your APK upload keys secure and rotate them regularly. Never commit keys to version control.