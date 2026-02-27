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
const ADMIN_EMAILS = ['d.mahesh.0510@gmail.com', 'ideamani07@gmail.com', 'kavithajvijay@gmail.com',
                            'rajvignesh@gmail.com', 'sspmech@gmail.com'];

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
    windowMs: 1 * 60 * 60 * 1000, // 24 Hours
    max: 200, // Limit each IP to 10 requests per window
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

// TIER 2: The Auth Limiter (Strict)
// This strictly stops brute-force password guessing.
const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour lock-out window
    max: 5, // Only 5 attempts allowed per hour
    message: { error: "Too many login attempts. Please try again after an hour to protect your account." },
    standardHeaders: true, 
    legacyHeaders: false,
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
    res.sendFile(path.join(__dirname, 'signup'));
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

// --- MAINTENANCE MODE WITH ADMIN BYPASS ---
app.use((req, res, next) => {
    const isMaintenance = process.env.MAINTENANCE_MODE === 'true';
    const bypassKey = process.env.BYPASS_KEY; // The secret word you set in Render

    // 1. If they provide the correct query param, let them in AND drop a session cookie
    if (bypassKey && req.query.bypass === bypassKey) {
        res.setHeader('Set-Cookie', `bypass_token=${bypassKey}; Path=/; HttpOnly`);
        return next();
    }

    // 2. Check if they already have the cookie from a previous visit
    const cookies = req.headers.cookie || '';
    if (bypassKey && cookies.includes(`bypass_token=${bypassKey}`)) {
        return next(); // Let them through!
    }

    // 3. If maintenance is ON and they have no bypass key/cookie, block them
    if (isMaintenance) {
        return res.status(503).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Site Maintenance</title>
                <style>
                    body { font-family: 'Inter', sans-serif; background: #f8fafc; color: #1e293b; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
                    .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; max-width: 500px; }
                    h1 { color: #2563eb; margin-top: 0; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>We're Upgrading! 🚀</h1>
                    <p>The Reunion 2026 registration portal is currently offline for a few minutes while we push an exciting new update to the form.</p>
                    <p><strong>Please check back shortly!</strong></p>
                </div>
            </body>
            </html>
        `);
    }

    // 4. Maintenance is off, proceed normally
    next(); 
});

app.post('/register', trackActivity('UPDATED_REGISTRATION'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];

        console.log('register api. token:', token);
        
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        console.log('register api. user:', user);
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });
        
        console.log('register api. req body:', req.body);
        // Add this at the very top of app.post('/register')
        // const { participant_name, email, mobile, department, class_reg_no, t_shirt_size } = req.body;
        // Destructure the exact fields from the updated UI
        const { 
            participant_name, email, mobile, department, class_reg_no,  location, t_shirt_size,
            adults_and_above_10, kids_6_10, kids_under_6,
            fri_family_join, fri_stay_type, sat_attend_type, thu_stay_type, sat_stay_type,
            donation_amount, performing_culturals, volunteering
        } = req.body;

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
                    participant_name: participant_name,
                    email: email,
                    mobile: mobile,
                    location: location,
                    department,       
                    class_reg_no,     
                    t_shirt_size: t_shirt_size,
                    adults_and_above_10: parseInt(adults_and_above_10) || 0,
                    kids_6_10: parseInt(kids_6_10) || 0,
                    kids_under_6: parseInt(kids_under_6) || 0,
                    fri_family_join: fri_family_join,
                    fri_stay_type: fri_stay_type,
                    sat_attend_type: sat_attend_type,
                    thu_stay_type: thu_stay_type,
                    sat_stay_type: sat_stay_type,
                    donation_amount: parseInt(donation_amount) || 0,
                    performing_culturals: performing_culturals,
                    volunteering: volunteering,
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
                participant_name: participant_name,
                email: email,
                mobile: mobile,
                location: location,
                department,       
                class_reg_no,     
                t_shirt_size: t_shirt_size,
                adults_and_above_10: parseInt(adults_and_above_10) || 0,
                kids_6_10: parseInt(kids_6_10) || 0,
                kids_under_6: parseInt(kids_under_6) || 0,
                fri_family_join: fri_family_join,
                fri_stay_type: fri_stay_type,
                sat_attend_type: sat_attend_type,
                thu_stay_type: thu_stay_type,
                sat_stay_type: sat_stay_type,
                donation_amount: parseInt(donation_amount) || 0,
                performing_culturals: performing_culturals,
                volunteering: volunteering,
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
            // ... (Inside your /register route, after saving to Supabase) ...

            // 1. RECALCULATE THE TOTAL COST SECURELY ON THE BACKEND
            const familyAdults = parseInt(adults_and_above_10) || 0;
            const kids6to10 = parseInt(kids_6_10) || 0;
            const donation = parseInt(donation_amount) || 0;

            let totalCost = 0;

            // Friday Event
            totalCost += 7000; 
            if (fri_family_join === 'family') {
                if (familyAdults > 0) totalCost += 2000 + ((familyAdults - 1) * 1500);
                totalCost += (kids6to10 * 1000);
            }

            // Saturday Event
            if (sat_attend_type !== 'no') {
                totalCost += 1500;
                if (sat_attend_type === 'family') {
                    if (familyAdults > 0) totalCost += 1000 + ((familyAdults - 1) * 1000);
                    totalCost += (kids6to10 * 500);
                }
            }

            // Stay Helper
            function getStayCost(type) {
                if (!type || type === 'no') return 0;
                let cost = 5500;
                if (type === 'family') {
                    if (familyAdults > 0) cost += 5500 + ((familyAdults - 1) * 2500);
                    cost += (kids6to10 * 2000);
                }
                return cost;
            }

            totalCost += getStayCost(thu_stay_type);
            totalCost += getStayCost(fri_stay_type);
            totalCost += getStayCost(sat_stay_type);
            totalCost += donation;

            // 2. HELPER TO MAKE EMAIL TEXT LOOK CLEAN
            const formatSelection = (val) => {
                if (val === 'family') return 'Yes, with family';
                if (val === 'self') return 'Yes, without family';
                if (val === 'yes') return 'Yes';
                return 'No';
            };

            // 3. BUILD THE HTML EMAIL TEMPLATE (with QR Code!)
            const emailHTML = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; background-color: #ffffff;">
                    
                    <h2 style="color: #2563eb; text-align: center;">Registration Confirmed!</h2>
                    <p>Hi ${participant_name},</p>
                    <p>Thank you for registering for the Class of 2001 Reunion. Your digital pass and registration summary are below.</p>
                    
                    <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #f8fafc; border-radius: 12px; border: 2px dashed #cbd5e1;">
                        <h3 style="color: #0f172a; margin-top: 0; margin-bottom: 5px;">Your Digital Pass</h3>
                        <p style="font-size: 13px; color: #64748b; margin-top: 0; margin-bottom: 15px;">Please present this QR code at the registration desk upon arrival.</p>
                        <img src="${qrCodeUrl}" alt="Registration QR Code" style="max-width: 200px; height: auto; border-radius: 8px; background: white; padding: 10px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);" />
                    </div>

                    <h3 style="border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-top: 30px;">Registration Summary</h3>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold; width: 45%;">Family Members:</td>
                            <td style="padding: 10px 0;">${familyAdults} Adults/>10y, ${kids6to10} Kids (6-10y), ${kids_under_6} Kids (<6y)</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Thursday Stay:</td>
                            <td style="padding: 10px 0;">${formatSelection(thu_stay_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Friday Reunion:</td>
                            <td style="padding: 10px 0;">${formatSelection(fri_family_join)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Friday Stay:</td>
                            <td style="padding: 10px 0;">${formatSelection(fri_stay_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Saturday Reunion:</td>
                            <td style="padding: 10px 0;">${formatSelection(sat_attend_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Saturday Stay:</td>
                            <td style="padding: 10px 0;">${formatSelection(sat_stay_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">T-Shirt Size:</td>
                            <td style="padding: 10px 0;">${t_shirt_size}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Culturals / Volunteering:</td>
                            <td style="padding: 10px 0;">${performing_culturals} / ${volunteering}</td>
                        </tr>
                    </table>

                    <div style="background-color: #fef3c7; padding: 15px; border-radius: 8px; text-align: center; margin-bottom: 20px; border: 1px solid #fde68a;">
                        <h3 style="margin: 0; color: #b45309;">Total Estimated Cost: ₹${totalCost.toLocaleString('en-IN')}</h3>
                        ${donation > 0 ? `<p style="margin: 5px 0 0 0; font-size: 13px; color: #b45309;">(Includes your generous ₹${donation} additional contribution)</p>` : ''}
                    </div>

                    <p style="font-size: 15px; font-weight: bold; color: #ef4444; border-left: 4px solid #ef4444; padding-left: 15px; background-color: #fef2f2; padding: 15px; border-radius: 0 8px 8px 0;">
                        One of the coordinators from your class will contact you for payment shortly.
                    </p>

                    <p style="margin-top: 30px; font-size: 13px; color: #64748b; text-align: center;">
                        We look forward to seeing you!<br>
                        <strong>— The Reunion Organizing Committee</strong>
                    </p>
                </div>
            `;

            try{
                // 4. NOW SEND THE EMAIL using Brevo/Nodemailer
                // Replace your existing email content parameter with `html: emailHTML`
                // e.g., await sendEmail({ to: email, subject: "Reunion Registration Confirmed", html: emailHTML });
                const sendSmtpEmail = new Brevo.SendSmtpEmail();
                let mobile = req.body.mobile;

                sendSmtpEmail.subject = "TCE Reunion 2026 Confirmation";
                sendSmtpEmail.htmlContent = emailHTML;
                
                // IMPORTANT: The sender email MUST be verified in your Brevo account
                sendSmtpEmail.sender = { "name": "Reunion Team", "email": "tcealumni2026@gmail.com" };
                sendSmtpEmail.to = [{ "email": email, "name": participant_name }];
                // sendSmtpEmail.cc = [{ "email": 'tce2001reunion@gmail.com', "name": "New User Registration" }];
                sendSmtpEmail.cc = [{ "email": 'tce2001reunion@gmail.com', "name": "New User Registration" }];

                // 4. Trigger the send
                await apiInstance.sendTransacEmail(sendSmtpEmail);
            }catch (emailError) {
                // 3. THE SAFETY NET
                // If Brevo blocks the send (e.g., 300 daily limit reached), it lands here instead of crashing your app.
                
                console.error(`[BREVO WARNING] Failed to send confirmation email to ${email}. Check daily quota!`);
                
                // Logs the exact reason Brevo rejected it
                const errorMessage = emailError.response ? emailError.response.text : emailError.message;
                console.error(`Error Details: ${errorMessage}`);
                
                // We deliberately do NOT throw an error to the frontend.
                // The data is safe in Supabase, so we let the function continue to the success response below.
            }
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

app.post('/login', authLimiter, async (req, res) => {
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
    console.log('recid=', postId);


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

// --- NIGHTLY BATCH PROCESS ENDPOINT ---
app.post('/api/cron/nightly-updates', async (req, res) => {
    
    // 1. Basic Security Check
    const cronSecret = req.headers['x-cron-secret'];
    if (cronSecret !== process.env.CRON_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        // 2. Fetch all records that need an update email
        const { data: updatedSubmissions, error } = await adminSupabase
            .from('submissions')
            .select('*')
            .eq('needs_update_email', true);

        if (error) throw error;
        
        if (!updatedSubmissions || updatedSubmissions.length === 0) {
            return res.status(200).json({ message: 'No updates to process today.' });
        }

        // Helper to format dropdown values cleanly
        const formatSelection = (val) => {
            if (val === 'family') return 'Yes, with family';
            if (val === 'self') return 'Yes, without family';
            if (val === 'yes') return 'Yes';
            if (!val || val === 'no') return 'No';
            return val;
        };

        let committeeTableRows = '';
        const processedUserIds = [];

        // 3. Loop through each updated record
        for (const sub of updatedSubmissions) {
            
            // --- A. RECALCULATE COST FOR THIS SPECIFIC RECORD ---
            const familyAdults = parseInt(sub.adults_and_above_10) || 0;
            const kids6to10 = parseInt(sub.kids_6_10) || 0;
            const kidsUnder6 = parseInt(sub.kids_under_6) || 0;
            const donation = parseInt(sub.donation_amount) || 0;

            let totalCost = 0;

            // Friday Event
            totalCost += 7000; 
            if (sub.fri_family_join === 'family') {
                if (familyAdults > 0) totalCost += 2000 + ((familyAdults - 1) * 1500);
                totalCost += (kids6to10 * 1000);
            }

            // Saturday Event
            if (sub.sat_attend_type !== 'no') {
                totalCost += 1500;
                if (sub.sat_attend_type === 'family') {
                    if (familyAdults > 0) totalCost += 1000 + ((familyAdults - 1) * 1000);
                    totalCost += (kids6to10 * 500);
                }
            }

            // Stay Helper
            function getStayCost(type) {
                if (!type || type === 'no') return 0;
                let cost = 5500;
                if (type === 'family') {
                    if (familyAdults > 0) cost += 5500 + ((familyAdults - 1) * 2500);
                    cost += (kids6to10 * 2000);
                }
                return cost;
            }

            totalCost += getStayCost(sub.thu_stay_type);
            totalCost += getStayCost(sub.fri_stay_type);
            totalCost += getStayCost(sub.sat_stay_type);
            totalCost += donation;

            // --- B. BUILD PARTICIPANT EMAIL ---
            const participantHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px;">
                    <h2 style="color: #2563eb; text-align: center;">Registration Update Confirmed</h2>
                    <p>Hi ${sub.participant_name},</p>
                    <p>We successfully recorded the recent changes to your Class of 2001 Reunion registration. Here is your updated summary:</p>
                    
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold; width: 45%;">Family Members:</td>
                            <td style="padding: 10px 0;">${familyAdults} Adults/>10y, ${kids6to10} Kids (6-10y), ${kidsUnder6} Kids (<6y)</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Thursday Stay:</td>
                            <td style="padding: 10px 0;">${formatSelection(sub.thu_stay_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Friday Reunion:</td>
                            <td style="padding: 10px 0;">${formatSelection(sub.fri_family_join)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Friday Stay:</td>
                            <td style="padding: 10px 0;">${formatSelection(sub.fri_stay_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Saturday Reunion:</td>
                            <td style="padding: 10px 0;">${formatSelection(sub.sat_attend_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Saturday Stay:</td>
                            <td style="padding: 10px 0;">${formatSelection(sub.sat_stay_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">T-Shirt Size:</td>
                            <td style="padding: 10px 0;">${sub.t_shirt_size}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Culturals / Volunteering:</td>
                            <td style="padding: 10px 0;">${sub.performing_culturals} / ${sub.volunteering}</td>
                        </tr>
                    </table>

                    <div style="background-color: #fef3c7; padding: 15px; border-radius: 8px; text-align: center;">
                        <h3 style="margin: 0; color: #b45309;">Updated Estimated Cost: ₹${totalCost.toLocaleString('en-IN')}</h3>
                        ${donation > 0 ? `<p style="margin: 5px 0 0 0; font-size: 13px; color: #b45309;">(Includes your ₹${donation} donation)</p>` : ''}
                    </div>
                </div>
            `;
            
            // Trigger Brevo API to send participantHtml to sub.email here

            // --- C. BUILD COMMITTEE ROW ---
            committeeTableRows += `
                <tr style="border-bottom: 1px solid #e2e8f0; font-size: 13px;">
                    <td style="padding: 10px 8px; font-weight: bold; color: #0f172a;">${sub.participant_name}<br><span style="font-weight: normal; color: #64748b; font-size: 11px;">${sub.mobile}</span></td>
                    <td style="padding: 10px 8px;">${familyAdults}A, ${kids6to10}K, ${kidsUnder6}I</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.thu_stay_type)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.fri_family_join)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.fri_stay_type)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.sat_attend_type)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.sat_stay_type)}</td>
                    <td style="padding: 10px 8px; font-weight: bold; color: #047857;">₹${totalCost.toLocaleString('en-IN')}</td>
                </tr>
            `;

            processedUserIds.push(sub.user_id);
        }

        // --- 4. BUILD & SEND COMMITTEE CONSOLIDATED EMAIL ---
        const committeeHtml = `
            <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 1000px; margin: 0 auto;">
                <h2 style="color: #0f172a;">Daily Registration Updates</h2>
                <p>The following ${updatedSubmissions.length} alumni modified their registrations in the last 24 hours.</p>
                <table style="width: 100%; border-collapse: collapse; text-align: left; background: #ffffff; border: 1px solid #cbd5e1;">
                    <tr style="background-color: #f8fafc; border-bottom: 2px solid #cbd5e1; font-size: 12px; text-transform: uppercase; color: #475569;">
                        <th style="padding: 12px 8px;">Alumnus</th>
                        <th style="padding: 12px 8px;">Family</th>
                        <th style="padding: 12px 8px;">Thu Stay</th>
                        <th style="padding: 12px 8px;">Fri Event</th>
                        <th style="padding: 12px 8px;">Fri Stay</th>
                        <th style="padding: 12px 8px;">Sat Event</th>
                        <th style="padding: 12px 8px;">Sat Stay</th>
                        <th style="padding: 12px 8px;">New Total</th>
                    </tr>
                    ${committeeTableRows}
                </table>
            </div>
        `;
        
        // Trigger Brevo API to send committeeHtml to reunion-committee@yourdomain.com here
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        // let mobile = req.body.mobile;

        sendSmtpEmail.subject = "TCE Reunion 2026 : Registration Changes";
        sendSmtpEmail.htmlContent = committeeHtml;
        
        // IMPORTANT: The sender email MUST be verified in your Brevo account
        sendSmtpEmail.sender = { "name": "Reunion Team", "email": "tcealumni2026@gmail.com" };
        sendSmtpEmail.to = [{ "email": "tce2001reunion@gmail.com", "name": "Reunion 2001 Admin" }];
        sendSmtpEmail.cc = [{ "email": "dmahesh2k@gmail.com", "name": "Sys Admin" }];

        // 4. Trigger the send
        await apiInstance.sendTransacEmail(sendSmtpEmail);

        // 5. Un-flag all records
        await adminSupabase
            .from('submissions')
            .update({ needs_update_email: false })
            .in('user_id', processedUserIds);

        return res.status(200).json({ message: `Successfully processed ${updatedSubmissions.length} updates.` });

    } catch (err) {
        console.error("Nightly Batch Error:", err);
        return res.status(500).json({ error: 'Batch process failed' });
    }
});

// --- ADMIN: UPDATE PAYMENT STATUS ---
app.post('/admin/update-payment', async (req, res) => {
    const { user_id, payment_status, amount_received } = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }

    try {
        // 1. Verify the user making the request is valid
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: 'Session expired or invalid token' });
        }

        // NOTE: In a fully locked-down app, you would also check here if `user.id` belongs to an Admin!

        // 2. Update the specific user's payment data in the database
        // Using the service_role key (supabase client) to bypass RLS if needed for admin actions
        const { error: updateError } = await adminSupabase
            .from('submissions')
            .update({
                payment_status: payment_status,
                amount_received: amount_received || 0
            })
            .eq('user_id', user_id);

        if (updateError) throw updateError;

        return res.status(200).json({ message: 'Payment details updated successfully!' });

    } catch (err) {
        console.error("Admin Payment Update Error:", err);
        return res.status(500).json({ error: 'Failed to update payment details.' });
    }
});

// --- FORGOT PASSWORD ENDPOINT ---
app.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
    }

    try {
        const { data, error } = await adminSupabase.auth.resetPasswordForEmail(email, {
            // IMPORTANT: Change this to your live domain once you deploy!
            // This is the page the user will land on when they click the link in their email.
            redirectTo: 'https://jalabulagems.com/update-password.html' 
        });

        if (error) {
            throw error;
        }

        // Security best practice: Always return success even if the email doesn't exist in the DB
        // This prevents malicious bots from guessing which emails belong to registered users.
        return res.status(200).json({ message: 'If an account exists, a reset link has been sent.' });

    } catch (err) {
        console.error("Forgot Password Error:", err);
        return res.status(500).json({ error: err.message || 'Failed to send reset link.' });
    }
});

// --- UPDATE PASSWORD ENDPOINT ---
app.post('/update-password', async (req, res) => {
    const { password } = req.body;
    const authHeader = req.headers['authorization'];
    
    // Extract the token from the "Bearer <token>" format
    const token = authHeader && authHeader.split(' ')[1];

    if (!token || !password) {
        return res.status(400).json({ error: 'Missing token or password.' });
    }

    try {
        // First, verify who this token belongs to
        const { data: { user }, error: userError } = await adminSupabase.auth.getUser(token);
        
        if (userError || !user) {
            return res.status(401).json({ error: 'Session expired. Please request a new reset link.' });
        }

        // Second, use the Supabase Admin API to forcefully update that user's password
        const { error: updateError } = await adminSupabase.auth.admin.updateUserById(user.id, { 
            password: password 
        });

        if (updateError) throw updateError;

        return res.status(200).json({ message: 'Password updated successfully!' });

    } catch (err) {
        console.error("Update Password Error:", err);
        return res.status(500).json({ error: 'Failed to update password.' });
    }
});

// --- UPTIME MONITOR ENDPOINT ---
// A lightweight route for cron-job.org or UptimeRobot to hit every 14 minutes.
// It returns a 200 OK instantly without querying the database.
app.get('/ping', (req, res) => {
    // Note: We deliberately do NOT put a console.log() here.
    // Otherwise, your server logs will be filled with ping messages every 14 minutes!
    res.status(200).send('pong');
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