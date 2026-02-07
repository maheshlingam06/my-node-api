const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per window
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: 'Upload limit reached!',
    standardHeaders: true,
    legacyHeaders: false,
    // This ensures we are definitely looking at the user's IP from the proxy
    keyGenerator: (req) => {
        // If x-forwarded-for exists, take the first IP in the comma-separated string
        const xff = req.headers['x-forwarded-for'];
        return xff ? xff.split(',')[0].trim() : req.ip;
    },
});

app.use(globalLimiter);

// 1. Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 2. Use Memory Storage (Safe for small files)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.get('/', (req, res) => {
    res.send(`
        <h1>Node.js API is Live!</h1>
        <ul>
            <li><a href="/gallery">View Gallery</a></li>
        </ul>
        <p>Use your local index.html to upload new files.</p>
    `);
});

// Add this route to your app.js
app.get('/gallery', async (req, res) => {
    try {
        // 1. List all files in the 'images' bucket
        const { data, error } = await supabase.storage
            .from('images')
            .list('', {
                limit: 100,
                sortBy: { column: 'created_at', order: 'desc' },
            });

        if (error) throw error;

        // 2. Generate Public URLs for each file
        const imageUrls = data.map(file => {
            const { data: publicUrl } = supabase.storage
                .from('images')
                .getPublicUrl(file.name);
            return publicUrl.publicUrl;
        });

        // 3. Build a simple HTML string to display them
        let html = '<h1>My Image Gallery</h1><div style="display: flex; flex-wrap: wrap; gap: 10px;">';
        imageUrls.forEach(url => {
            html += `<img src="${url}" style="width: 200px; height: 200px; object-fit: cover; border-radius: 8px;">`;
        });
        html += '</div><br><a href="/">Upload more</a>';

        res.send(html);

    } catch (err) {
        res.status(500).send("Error loading gallery: " + err.message);
    }
});

app.post('/upload-file', uploadLimiter, upload.single('myFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file.');

        console.log("Request from IP:", req.ip);
        console.log("X-Forwarded-For:", req.headers['x-forwarded-for']);

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