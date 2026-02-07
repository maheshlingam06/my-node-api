const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
// const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns');
const resend = new Resend(process.env.RESEND_API_KEY);

dns.setDefaultResultOrder('ipv4first'); // Force Node to prefer IPv4 addresses

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


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
        // 1. Fetch data from the 'submissions' table
        const { data: submissions, error } = await supabase
            .from('submissions')
            .select('*')
            .order('id', { ascending: false }); // Show newest first

        if (error) throw error;

        // 2. Build the HTML with the database content
        let html = `
            <style>
                .card { border: 1px solid #ccc; padding: 10px; border-radius: 8px; width: 220px; }
                .gallery { display: flex; flex-wrap: wrap; gap: 20px; font-family: sans-serif; }
                img { width: 200px; height: 200px; object-fit: cover; border-radius: 4px; }
            </style>
            <h1>Community Gallery</h1>
            <div class="gallery">
        `;

        submissions.forEach(item => {
            html += `
                <div class="card">
                    <img src="${item.image_url}">
                    <p><strong>${item.username}</strong></p>
                    <p>${item.message}</p>
                </div>
            `;
        });

        html += '</div><br><a href="/">Back to Home</a>';
        res.send(html);

    } catch (err) {
        res.status(500).send("Gallery Error: " + err.message);
    }
});

// Add these lines near the top of your app.js if they aren't there
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// NEW SEPARATE REGISTRATION API
app.post('/register', uploadLimiter, async (req, res) => {
    try {
        // Destructure all the fields from the new UI
        const { 
            participant_name,
            email, 
            mobile, 
            location, 
            teens_adults, 
            kids, 
            thu_night, 
            fri_reunion, 
            fri_night, 
            sat_reunion, 
            sat_night 
        } = req.body;

        // 2. Generate QR Code as a Buffer
        const qrData = `Reunion-2026-${mobile}`;
        const qrCodeBuffer = await QRCode.toBuffer(qrData);

        // 3. Upload QR Code to Supabase Storage
        const qrFileName = `qrcodes/${mobile}-${Date.now()}.png`;
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from('images')
            .upload(qrFileName, qrCodeBuffer, { contentType: 'image/png' });

        if (uploadError) throw uploadError;
        const { data: qrUrl } = supabase.storage.from('images').getPublicUrl(qrFileName);

        // Insert into the 'submissions' table
        const { data, error } = await supabase
            .from('submissions')
            .insert([
                { 
                    participant_name,
                    mobile,
                    email,
                    location,
                    teens_adults: parseInt(teens_adults) || 0,
                    kids: parseInt(kids) || 0,
                    thu_night,
                    fri_reunion,
                    fri_night,
                    sat_reunion,
                    sat_night,
                    qr_code_url: qrUrl.publicUrl
                }
            ]);

        if (error) throw error;

        // 5. Send Confirmation Email
        // SEND EMAIL VIA HTTP API (Bypasses Render's Port Block)
        const { dataResend, errorResend } = await resend.emails.send({
            from: 'Family Reunion <onboarding@resend.dev>', // Use this for testing
            to: email,
            subject: 'Your Family Reunion QR Code',
            html: `
                <h1>Hi ${participant_name}!</h1>
                <p>Your registration is confirmed. Here is your check-in code:</p>
                <img src="${qrUrl.publicUrl}" width="200" />
            `
        });

        if (errorResend) throw errorResend;

        res.send("Registration Successful! Check your email.");

    } catch (err) {
        console.error("Registration Error:", err.message);
        res.status(500).send("Registration failed: " + err.message);
    }
});

app.post('/upload-file', uploadLimiter, upload.single('myFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file.');

        // 1. Upload File to Storage (as before)
        const file = req.file;
        const fileName = `${Date.now()}-${file.originalname}`;
        const { data: storageData, error: storageError } = await supabase.storage
            .from('images')
            .upload(fileName, file.buffer, { contentType: file.mimetype });

        if (storageError) throw storageError;

        const { data: publicUrl } = supabase.storage.from('images').getPublicUrl(fileName);

        // 2. Insert Data into the Database Table
        // We get 'username' and 'message' from the UI (req.body)
        const { username, message } = req.body;

        const { data: dbData, error: dbError } = await supabase
            .from('submissions')
            .insert([
                { 
                    username: username || 'Anonymous', 
                    message: message || 'No message', 
                    image_url: publicUrl.publicUrl 
                }
            ]);

        if (dbError) throw dbError;

        res.send({
            message: 'File uploaded and database record saved!',
            imageUrl: publicUrl.publicUrl
        });

    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Secure server running on port ${PORT}`);
});