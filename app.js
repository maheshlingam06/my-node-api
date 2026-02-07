const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // Only 5 uploads per hour per IP
    message: 'Upload limit reached. Please try again in an hour.',
});

app.use(globalLimiter);
app.set('trust proxy', 1);

// 1. Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 2. Use Memory Storage (Safe for small files)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/upload-file', uploadLimiter, upload.single('myFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file.');

        const file = req.file;
        const fileName = `${Date.now()}-${file.originalname}`;

        // 3. Upload to Supabase 'images' bucket
        const { data, error } = await supabase.storage
            .from('images')
            .upload(fileName, file.buffer, {
                contentType: file.mimetype,
                upsert: false
            });

        if (error) throw error;

        // 4. Get the Public URL
        const { data: publicUrl } = supabase.storage
            .from('images')
            .getPublicUrl(fileName);

        res.send({
            message: 'Securely uploaded to Supabase!',
            url: publicUrl.publicUrl
        });

    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Secure server running on port ${PORT}`);
});