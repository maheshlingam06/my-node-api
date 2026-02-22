const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
// const nodemailer = require('nodemailer');
// const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns');
// const resend = new Resend(process.env.RESEND_API_KEY);
const Brevo = require('@getbrevo/brevo');
// 1. Initialize the Brevo Transactional Emails API
const apiInstance = new Brevo.TransactionalEmailsApi();
// --- ADMIN CONFIGURATION ---
// Add the emails of anyone who should have access to the dashboard
const ADMIN_EMAILS = ['d.mahesh.0510@gmail.com', 'another.admin@example.com'];

// 2. Set your API Key
// let defaultClient = Brevo.ApiClient.instance;
// let apiKey = defaultClient.authentications['api-key'];
// apiKey.apiKey = process.env.BREVO_API_KEY;
apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

dns.setDefaultResultOrder('ipv4first'); // Force Node to prefer IPv4 addresses

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));


const PORT = process.env.PORT || 10000;

// Configure Multer for multiple files in memory
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB total limit
});

const globalLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 Hours
    max: 10, // Limit each IP to 10 requests per window
    message: 'Too many requests from this IP, please try after some time',
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
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

// --- ADD THIS NEAR THE TOP OF APP.JS ---
// Prevent caching for HTML pages so "Back" button forces a reload
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/admin' || req.path === '/registration') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

// 1. Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const adminSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// 2. Use Memory Storage (Safe for small files)
const storage = multer.memoryStorage();

// --- AUTO-LOGGING MIDDLEWARE ---
const trackActivity = (actionName) => {
    return async (req, res, next) => {
        
        // res.on('finish') ensures we only log the event AFTER it successfully completes
        res.on('finish', async () => {
            // Only log if the HTTP status was successful (200-299)
            if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                    const authHeader = req.headers.authorization;
                    if (!authHeader) return;
                    
                    const token = authHeader.split(' ')[1];
                    const { data: { user }, error } = await supabase.auth.getUser(token);
                    
                    if (user) {
                        await supabase.from('user_logs').insert([{
                            user_id: user.id,
                            email: user.email,
                            action: actionName,
                            details: { endpoint: req.originalUrl }
                        }]);
                    }
                } catch (err) {
                    console.error("Backend logging failed:", err);
                }
            }
        });
        
        // Continue processing the original request
        next();
    };
};


// const upload = multer({ storage: storage });

// Helper function to verify reCAPTCHA
async function verifyRecaptcha(token) {
    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    const response = await axios.post(
            `https://www.google.com/recaptcha/api/siteverify`,
            null,
            {
                params: {
                    secret: secretKey,
                    response: token
                }
            }
        );

    return response.data.success && response.data.score >= 0.5; 
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'signup.html'));
});

app.get('/signup', (req, res) => {
    // const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'signup.html'), 'utf8');
    console.log('html=', html);
    console.log('sitekey=', process.env.YOUR_SITE_KEY);
    // Replace a placeholder in your HTML with the ENV variable
    html = html.replace(/__SITE_KEY__/g, process.env.YOUR_SITE_KEY);
    console.log('html after replace=', html);
    res.send(html);
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

// 1. New Signup API (Account Creation)
app.post('/signup', trackActivity('USER_SIGNUP'), uploadLimiter, async (req, res) => {
    try {
        const { email, password, captchaToken } = req.body;

        // Verify reCAPTCHA
        const isHuman = await verifyRecaptcha(captchaToken);
        if (!isHuman) return res.status(403).json({ error: "Bot activity detected." });

        // Create User in Supabase Auth
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                // Change this to your live domain when you deploy!
                // This dictates where the email link sends them after verifying.
                emailRedirectTo: '/login' 
            }
        });

        if (error) throw error;

        // Send back success - Frontend will then show the details form
        res.status(200).json({ 
            message: "Account created! Please check your email for verification.",
            user: data.user,
            session: data.session
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
  
// // NEW SEPARATE REGISTRATION API
// app.post('/register', uploadLimiter, async (req, res) => {
//     try {

//         // 1. Get the token from the "Authorization: Bearer <token>" header
//         const authHeader = req.headers.authorization;
//         const token = authHeader && authHeader.split(' ')[1];

//         if (!token) return res.status(401).json({ error: "Please login again." });

//         // 2. Ask Supabase Auth to verify the token and give us the user
//         const { data: { user }, error: authError } = await supabase.auth.getUser(token);

//         if (authError || !user) {
//             return res.status(401).json({ error: "Session expired. Please login." });
//         }

//         // 3. Now we have user.id! 
//         const userId = user.id;
//         // Destructure all the fields from the new UI
//         const {
//             participant_name,
//             email, 
//             mobile, 
//             location, 
//             teens_adults, 
//             kids, 
//             thu_night, 
//             fri_reunion, 
//             fri_night, 
//             sat_reunion, 
//             sat_night 
//         } = req.body;

//         // 2. Generate QR Code as a Buffer
//         const qrData = `Reunion-2026-${mobile}`;
//         const qrCodeBuffer = await QRCode.toBuffer(qrData);

//         // 3. Upload QR Code to Supabase Storage
//         const qrFileName = `qrcodes/${mobile}-${Date.now()}.png`;
//         const { data: uploadData, error: uploadError } = await supabase.storage
//             .from('images')
//             .upload(qrFileName, qrCodeBuffer, { contentType: 'image/png' });

//         if (uploadError) throw uploadError;
//         const { data: qrUrl } = supabase.storage.from('images').getPublicUrl(qrFileName);


//         // console.log('New user data=', userId, ' ', participant_name, ' ', email, ' ', qrUrl.publicUrl);

//         // Insert into the 'submissions' table
//         const { data, error } = await supabase
//             .from('submissions')
//             .upsert([
//                 { 
//                     user_id: userId,
//                     participant_name,
//                     mobile,
//                     email,
//                     location,
//                     teens_adults: parseInt(teens_adults) || 0,
//                     kids: parseInt(kids) || 0,
//                     thu_night,
//                     fri_reunion,
//                     fri_night,
//                     sat_reunion,
//                     sat_night,
//                     qr_code_url: qrUrl.publicUrl
//                 }
//             ]);

//         if (error) throw error;

//         // 5. Send Confirmation Email
//         // 3. Prepare the Email using Brevo's HTTP API (Bypasses Render's port blocks)
//         const sendSmtpEmail = new Brevo.SendSmtpEmail();

//         sendSmtpEmail.subject = "Your Family Reunion QR Code";
//         sendSmtpEmail.htmlContent = `
//             <div style="font-family: Arial, sans-serif; text-align: center;">
//                 <h1>Hello ${participant_name}!</h1>
//                 <p>Your registration is confirmed. Please present the code below at the resort check-in.</p>
//                 <img src="${qrUrl.publicUrl}" alt="Check-in QR Code" width="250" />
//                 <p><strong>Mobile:</strong> ${mobile}</p>
//                 <p>We look forward to seeing you at Heritage Resort!</p>
//             </div>`;
        
//         // IMPORTANT: The sender email MUST be verified in your Brevo account
//         sendSmtpEmail.sender = { "name": "Reunion Team", "email": "d.mahesh.0510@gmail.com" };
//         sendSmtpEmail.to = [{ "email": email, "name": participant_name }];

//         // 4. Trigger the send
//         await apiInstance.sendTransacEmail(sendSmtpEmail);

//         // res.send("Registration Successful! Check your email for your unique QR code.");
//         res.status(200).json({ 
//             message: "Registration Successful! Check your email for your unique QR code." 
//         });

//     } catch (err) {
//         console.error("Registration Error:", err.message);
//         res.status(500).json({ message: "Registration failed: " + err.message});
//     }
// });

app.post('/register', trackActivity('UPDATED_REGISTRATION'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        console.log('register api. token:', token);
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        console.log('register api. user:', user);
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });
        
        console.log('register api. req body:', req.body);
        // Add this at the very top of app.post('/register')
        const { participant_name, email, mobile, department, class_reg_no, t_shirt_size } = req.body;
        console.log('register api. participant_name, email, mobile:', participant_name, email, mobile);

        
        // 1. Create a "User-Specific" client for this request
        // This is the clean way to handle RLS with the ANON key
        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });
        // 1. Fetch existing data first
        const { data: existing } = await userSupabase
            .from('submissions')
            .select('participant_name, email, mobile, qr_code_url')
            .eq('user_id', user.id)
            .single();

        let qrCodeUrl = existing?.qr_code_url;
        let shouldSendEmail = false;

        // 2. Logic: Should we generate a new QR & Email?
        // - If brand new registration (no existing record)
        // - OR if the name/email has changed (which changes the QR content)
        if (!existing || 
            existing.participant_name !== req.body.participant_name || 
            existing.email !== req.body.email || existing.mobile !== req.body.mobile) {
            
            console.log("Generating new QR and triggering email...");
            let mobile = req.body.mobile;
            
            // ... [Insert your existing QR generation and Storage upload code here] ...
            // qrCodeUrl = result.publicUrl;
            const qrData = `Reunion-2026-${mobile}`;
            const qrCodeBuffer = await QRCode.toBuffer(qrData);

            // 3. Upload QR Code to userSupabase Storage
            const qrFileName = `qrcodes/${mobile}-${Date.now()}.png`;
            const { data: uploadData, error: uploadError } = await adminSupabase.storage
                .from('images')
                .upload(qrFileName, qrCodeBuffer, { contentType: 'image/png' });

            console.log("After Generating new QR and triggering email...");
            if (uploadError) throw uploadError;
            const { data: qrUrl } = adminSupabase.storage.from('images').getPublicUrl(qrFileName);
            qrCodeUrl = qrUrl.publicUrl;
            
            shouldSendEmail = true;
        } else {
            console.log("Silent update - no QR/Email needed.");
        }

        console.log("Before existing...");

        if (existing){
            // 3. Perform the Upsert
            const { error: dbError } = await userSupabase
                .from('submissions')
                .update({ 
                    user_id: user.id,
                    participant_name: req.body.participant_name,
                    email: req.body.email,
                    mobile: req.body.mobile,
                    location: req.body.location,
                    teens_adults: parseInt(req.body.teens_adults) || 0,
                    kids_6_10: parseInt(req.body.kids_6_10) || 0,
                    kids_under_6: parseInt(req.body.kids_under_6) || 0,
                    thu_night: req.body.thu_night,
                    fri_reunion: req.body.fri_reunion,
                    fri_night: req.body.fri_night,
                    sat_reunion: req.body.sat_reunion,
                    sat_night: req.body.sat_night,
                    department,       
                    class_reg_no,     
                    t_shirt_size,     
                    qr_code_url: qrCodeUrl // Uses existing one if no change
                }, { onConflict: 'user_id' })
                .eq('user_id', user.id);
                if (dbError) throw dbError;
        }
        else{
             // 3. Perform the Upsert
            const { error: dbError } = await userSupabase
            .from('submissions')
            .insert({ 
                user_id: user.id,
                participant_name: req.body.participant_name,
                email: req.body.email,
                mobile: req.body.mobile,
                location: req.body.location,
                teens_adults: parseInt(req.body.teens_adults) || 0,
                kids_6_10: parseInt(req.body.kids_6_10) || 0,
                kids_under_6: parseInt(req.body.kids_under_6) || 0,
                thu_night: req.body.thu_night,
                fri_reunion: req.body.fri_reunion,
                fri_night: req.body.fri_night,
                sat_reunion: req.body.sat_reunion,
                sat_night: req.body.sat_night,
                department,       
                class_reg_no,     
                t_shirt_size,     
                qr_code_url: qrCodeUrl // Uses existing one if no change
            }, { onConflict: 'user_id' });
            if (dbError) throw dbError;
        }

        console.log("Before shouldSendEmail...");

        // 4. Send email ONLY if needed
        if (shouldSendEmail) {
            // ... [Insert your Brevo email code here] ...
            // 5. Send Confirmation Email
            // 3. Prepare the Email using Brevo's HTTP API (Bypasses Render's port blocks)
            const sendSmtpEmail = new Brevo.SendSmtpEmail();
            let mobile = req.body.mobile;

            sendSmtpEmail.subject = "Your Family Reunion QR Code";
            sendSmtpEmail.htmlContent = `
                <div style="font-family: Arial, sans-serif; text-align: center;">
                    <h1>Hello ${participant_name}!</h1>
                    <p>Your registration is confirmed. Please present the code below at the resort check-in.</p>
                    <img src="${qrCodeUrl}" alt="Check-in QR Code" width="250" />
                    <p><strong>Mobile:</strong> ${mobile}</p>
                    <p>We look forward to seeing you at Heritage Resort!</p>
                </div>`;
            
            // IMPORTANT: The sender email MUST be verified in your Brevo account
            sendSmtpEmail.sender = { "name": "Reunion Team", "email": "d.mahesh.0510@gmail.com" };
            sendSmtpEmail.to = [{ "email": email, "name": participant_name }];

            // 4. Trigger the send
            await apiInstance.sendTransacEmail(sendSmtpEmail);
        }

        console.log("Before res json...");

        res.json({ 
            message: shouldSendEmail ? "Registration updated and email sent!" : "Registration updated successfully!",
            emailSent: shouldSendEmail 
        });

    } catch (err) {
        console.error("Register Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        if (error) throw error;

        var isAdminUser = false;
        if (ADMIN_EMAILS.includes(email)){
            isAdminUser = true;
        }
        
        // Return the user session
        res.status(200).json({ message: "Login successful", session: data.session, userType: isAdminUser ? 'x' : '' });
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
});

app.get('/login', (req, res) => {
    // const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'login_.html'), 'utf8'); 
    console.log('html=', html);
    console.log('sitekey=', process.env.YOUR_SITE_KEY);
    // Replace a placeholder in your HTML with the ENV variable
    html = html.replace(/__SITE_KEY__/g, process.env.YOUR_SITE_KEY);
    res.send(html);
});

app.get('/get-registration', trackActivity('GET_REGISTRATION'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        console.log('token=', token);
        if (!token) return res.status(401).json({ error: "Unauthorized" });

        // 1. Verify user
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: "Invalid session" });
        
        console.log('user data=', user);
        
        // 1. Create a "User-Specific" client for this request
        // This is the clean way to handle RLS with the ANON key
        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });
        // 2. Fetch their specific submission
        const { data, error } = await userSupabase
            .from('submissions')
            .select('*')
            .eq('user_id', user.id)
            .single(); // We only expect one registration per user

        if (error && error.code !== 'PGRST116') throw error; // PGRST116 means no record found (which is fine)
        console.log('data from userSupabase:', data);

        res.status(200).json(data || {}); 
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN ROUTE ---
app.get('/api/admin/all-registrations', trackActivity('ADMIN_GETALL_REGISTRATIONS'), async (req, res) => {
    try {
        console.log("--- ADMIN ACCESS ATTEMPT ---");
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Unauthorized" });
        const authHeader = req.headers.authorization;
        console.log("1. Header received:", authHeader ? "YES" : "NO");

        // 1. Verify who is asking
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            console.log("2. Auth Check Failed:", authError?.message);
            return res.status(401).json({ error: "Invalid session" });
        }

        // 2. SECURITY CHECK: Only allow YOUR email to see this data
        // Replace this string with the actual email you use to login as admin
        const ADMIN_EMAILS = ['d.mahesh.0510@gmail.com']; 
        
        if (!ADMIN_EMAILS.includes(user.email)) {
            return res.status(403).json({ error: "Access Denied: Admin rights required." });
        }

        // 3. Fetch ALL data using the Service Role (Bypassing RLS)
        // Ensure you initialized 'adminSupabase' with the SERVICE_ROLE_KEY at the top of app.js
        const { data: allRows, error: dbError } = await adminSupabase 
            .from('submissions')
            .select('*')
            .order('created_at', { ascending: false });

        if (dbError) throw dbError;

        res.json(allRows);

    } catch (err) {
        console.error("Admin Fetch Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- FETCH AUDIT LOGS ROUTE (SECURED) ---
app.get('/api/logs', trackActivity('ADMIN_GET_AUDITLOGS'), async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    
    const token = authHeader.split(' ')[1];

    try {
        // 1. Same logic used in /get-registration to verify the user
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // 2. NEW: Verify if the user is an Admin
        if (!ADMIN_EMAILS.includes(user.email)) {
            console.warn(`Unauthorized admin access attempt by: ${user.email}`);
            return res.status(403).json({ error: 'Forbidden: Admin privileges required.' });
        }

        // 3. Fetch the logs (Only runs if they passed the admin check)
        const { data, error } = await adminSupabase
            .from('user_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;

        res.json(data);

    } catch (error) {
        console.error("Error fetching logs:", error);
        res.status(500).json({ error: "Failed to fetch audit logs" });
    }
});

// --- FETCH ALL BLOG POSTS (SECURE) ---
app.get('/api/blog', async (req, res) => {
    // 1. Require the token
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    
    const token = authHeader.split(' ')[1];

    try {
        // 2. Verify the token belongs to a valid logged-in user
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // 3. Fetch the posts only if they passed the security check
        const { data, error } = await adminSupabase
            .from('blog_posts')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);

    } catch (error) {
        console.error("Error fetching blog posts:", error);
        res.status(500).json({ error: "Failed to load posts" });
    }
});

// --- CREATE A NEW BLOG POST ---
// We reuse your trackActivity middleware to log this!
app.post('/api/blog', trackActivity('CREATED_BLOG_POST'), async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    
    const token = authHeader.split(' ')[1];

    try {
        // 1. Verify user
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

        // 2. Grab post details
        const { title, content, author_name } = req.body;

        // 3. Insert into database
        const { error: dbError } = await supabase
            .from('blog_posts')
            .insert([{
                user_id: user.id,
                author_name: author_name || 'Alumnus',
                title: title,
                content: content
            }]);

        if (dbError) throw dbError;
        res.json({ success: true });

    } catch (error) {
        console.error("Error creating post:", error);
        res.status(500).json({ error: "Failed to publish post" });
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

// --- UPLOAD BLOG IMAGE ---
app.post('/api/upload-image', uploadLimiter, upload.single('image'), async (req, res) => {
    // Optional: Secure this route just like the others
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });

    try {
        if (!req.file) return res.status(400).json({ error: 'No image provided' });

        const file = req.file;
        // Clean the filename and add a timestamp so files don't overwrite each other
        const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '');
        const fileName = `blog-photos/${Date.now()}-${cleanName}`;

        // Upload to your existing 'images' bucket in Supabase
        const { data, error } = await adminSupabase.storage
            .from('images')
            .upload(fileName, file.buffer, { contentType: file.mimetype });

        if (error) throw error;

        // Get the public URL to send back to the Quill editor
        const { data: urlData } = adminSupabase.storage.from('images').getPublicUrl(fileName);

        res.json({ url: urlData.publicUrl });

    } catch (err) {
        console.error("Blog Image Upload Error:", err);
        res.status(500).json({ error: "Failed to upload image" });
    }
});

// --- DELETE A BLOG POST & ATTACHED IMAGES ---
app.delete('/api/blog/:id', trackActivity('DELETED_BLOG_POST'), async (req, res) => {
    console.log('reached app delete');
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    
    const token = authHeader.split(' ')[1];

    try {
        // 1. Verify user identity
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

        const postId = req.params.id;

    console.log('reached 1');


        // This is the clean way to handle RLS with the ANON key
        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // 2. FETCH THE POST FIRST (To check ownership and find images)
        const { data: post, error: fetchError } = await userSupabase
            .from('blog_posts')
            .select('content, user_id')
            .eq('id', postId)
            .single();

        if (fetchError || !post) {
            return res.status(404).json({ error: 'Post not found' });
        }

    console.log('reached 2');


        // 3. SECURITY: Make sure this user actually owns the post
        if (post.user_id !== user.id) {
            return res.status(403).json({ error: 'Forbidden: You can only delete your own posts' });
        }

        // 4. FIND AND DELETE ATTACHED IMAGES
        // We use a regular expression to find all image URLs inside the rich text HTML
        const imgRegex = /<img[^>]+src="([^">]+)"/g;
        let match;
        const filePathsToDelete = [];
        
        // This is the base URL Supabase uses for your 'images' bucket
        const storageBaseUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/images/`;

        while ((match = imgRegex.exec(post.content)) !== null) {
            const imgUrl = match[1];
            // Only try to delete images that are hosted in our Supabase bucket
            if (imgUrl.startsWith(storageBaseUrl)) {
                // Strip the base URL to get the exact file path (e.g., 'blog-photos/123-img.jpg')
                const filePath = imgUrl.replace(storageBaseUrl, '');
                filePathsToDelete.push(filePath);
            }
        }

    console.log('reached 3');


        // If we found images, tell Supabase Storage to delete them
        if (filePathsToDelete.length > 0) {
            console.log("Deleting orphaned blog images:", filePathsToDelete);
            // We use adminSupabase to bypass any strict Storage RLS policies
            const { error: storageError } = await adminSupabase.storage
                .from('images')
                .remove(filePathsToDelete);
                
            if (storageError) {
                console.error("Warning: Failed to delete images from storage:", storageError);
                // We log the error, but we still proceed to delete the post row!
            }
        }

    console.log('reached 4');


        // 5. FINALLY, DELETE THE DATABASE ROW
        const { error: dbError } = await userSupabase
            .from('blog_posts')
            .delete()
            .eq('id', postId);

        if (dbError) throw dbError;

    console.log('reached 5');


        res.json({ success: true, deletedImages: filePathsToDelete.length });

    } catch (error) {
        console.error("Error deleting post:", error);
        res.status(500).json({ error: "Failed to delete post" });
    }
});

app.post('/api/salesforce/upload', upload.any(), async (req, res) => {
    try {
        const { brokercode, hashcode } = req.body;
        const files = req.files || [];

        const uploadResults = [];

        for (const file of files) {
            // We specify the folder in the path string: 'salesforce-project/...'
            const filePath = `salesforce-project/${brokercode}/${file.fieldname}-${Date.now()}-${file.originalname}`;

            console.log('files received:' + filePath);
            
            const { data, error } = await supabase.storage
                .from('images') 
                .upload(filePath, file.buffer, {
                    contentType: file.mimetype,
                    upsert: true 
                });

            if (error) throw error;
            
            const { data: urlData } = supabase.storage.from('images').getPublicUrl(filePath);
            
            uploadResults.push({
                document: file.fieldname,
                url: urlData.publicUrl
            });
        }

        res.json({
            status: "Success",
            uploads: uploadResults
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Secure server running on port ${PORT}`);
});