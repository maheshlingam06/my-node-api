const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

// 1. Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 2. Use Memory Storage (Safe for small files)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/upload-file', upload.single('myFile'), async (req, res) => {
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