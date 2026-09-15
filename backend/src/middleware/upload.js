// Multer config: accept single or multiple images, hold in memory
// to stream to Supabase Storage and OCR pipeline without touching disk.
const multer = require('multer');

const storage = multer.memoryStorage();

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];

const baseMulter = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG or WEBP images are allowed.'));
    }
    cb(null, true);
  },
});

// Support single 'image' (legacy), 'images' array, and multi-field 'images'
// We expose helpers to handle all cases in the route.
const uploadSingle = baseMulter.single('image');
const uploadMultiple = baseMulter.array('images', 8);
const uploadAnyImages = baseMulter.fields([
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 8 },
]);

// Legacy export: used as `upload.single()` still works for backward compat
// We attach extra helpers for new code.
const upload = baseMulter;
upload.single = baseMulter.single.bind(baseMulter);
upload.array = baseMulter.array.bind(baseMulter);
upload.fields = baseMulter.fields.bind(baseMulter);
upload.uploadSingle = uploadSingle;
upload.uploadMultiple = uploadMultiple;
upload.uploadAnyImages = uploadAnyImages;
upload.ALLOWED_MIME = ALLOWED_MIME;

module.exports = upload;
