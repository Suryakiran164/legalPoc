// Multer config: accept a single image, hold it in memory so we can stream
// it straight to Supabase Storage and to the OCR microservice without
// touching disk.
const multer = require('multer');

const storage = multer.memoryStorage();

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG or WEBP images are allowed.'));
    }
    cb(null, true);
  },
});

module.exports = upload;
