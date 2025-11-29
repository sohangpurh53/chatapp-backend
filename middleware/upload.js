const multer = require('multer');
const mime = require('mime-types');

// File size limits (in bytes)
const FILE_SIZE_LIMITS = {
  image: parseInt(process.env.MAX_IMAGE_SIZE) || 10 * 1024 * 1024,    // 10 MB
  video: parseInt(process.env.MAX_VIDEO_SIZE) || 10 * 1024 * 1024,    // 10 MB
  audio: parseInt(process.env.MAX_AUDIO_SIZE) || 10 * 1024 * 1024,    // 10 MB
  document: parseInt(process.env.MAX_DOCUMENT_SIZE) || 50 * 1024 * 1024, // 50 MB
};

// Allowed MIME types
const ALLOWED_TYPES = {
  image: [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/svg+xml'
  ],
  video: [
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    'video/mpeg',
    'video/x-matroska'
  ],
  audio: [
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    'audio/aac',
    'audio/x-m4a'
  ],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/x-rar-compressed',
    'application/x-7z-compressed'
  ],
};

// Get file type from mimetype
const getFileTypeFromMime = (mimetype) => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

// Configure multer for memory storage
const storage = multer.memoryStorage();

// File filter function
const fileFilter = (req, file, cb) => {
  const fileType = getFileTypeFromMime(file.mimetype);
  const allowedTypes = ALLOWED_TYPES[fileType] || [];

  console.log(`📋 Validating file: ${file.originalname} (${file.mimetype})`);

  if (allowedTypes.includes(file.mimetype)) {
    console.log(`✅ File type allowed: ${file.mimetype}`);
    cb(null, true);
  } else {
    console.log(`❌ File type not allowed: ${file.mimetype}`);
    cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }
};

// Create multer upload instance
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: Math.max(...Object.values(FILE_SIZE_LIMITS)), // Use max limit (50MB)
    files: 1, // Only one file at a time
  },
});

// Middleware to validate file size based on type
const validateFileSize = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ 
      error: 'No file uploaded',
      message: 'Please select a file to upload'
    });
  }

  const fileType = getFileTypeFromMime(req.file.mimetype);
  const maxSize = FILE_SIZE_LIMITS[fileType];

  console.log(`📏 Validating file size: ${req.file.size} bytes (max: ${maxSize} bytes for ${fileType})`);

  if (req.file.size > maxSize) {
    const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(2);
    const actualSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
    
    return res.status(400).json({
      error: 'File size exceeds limit',
      message: `${fileType} files must be less than ${maxSizeMB} MB. Your file is ${actualSizeMB} MB.`,
      maxSize,
      actualSize: req.file.size,
      fileType
    });
  }

  console.log(`✅ File size valid`);
  req.fileType = fileType;
  next();
};

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'The uploaded file exceeds the maximum allowed size',
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: 'Too many files',
        message: 'You can only upload one file at a time',
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: 'Unexpected field',
        message: 'The file field name is incorrect',
      });
    }
  }
  
  if (err) {
    return res.status(400).json({
      error: 'Upload error',
      message: err.message || 'An error occurred during file upload',
    });
  }
  
  next();
};

// Get human-readable file size
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

module.exports = {
  upload,
  validateFileSize,
  handleMulterError,
  FILE_SIZE_LIMITS,
  ALLOWED_TYPES,
  getFileTypeFromMime,
  formatFileSize,
};
