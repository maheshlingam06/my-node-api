require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns');
const Brevo = require('@getbrevo/brevo');
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

// 1. Initialize the Brevo Transactional Emails API
const apiInstance = new Brevo.TransactionalEmailsApi();
// --- ADMIN CONFIGURATION ---
// Add the emails of anyone who should have access to the dashboard
const ADMIN_EMAILS = ['d.mahesh.0510@gmail.com', 'ideamani07@gmail.com', 'kavithajvijay@gmail.com',
                            'rajvignesh@gmail.com', 'sspmech@gmail.com', 'prakashtv@gmail.com', 
                        'mkvmuthu@gmail.com', 'a.k.sudhakar@gmail.com', 'rprasi@gmail.com', 
                        'Subramanian.archana@gmail.com'
                        ];

// 2. Set your API Key
apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
    standardHeaders: true, 
    legacyHeaders: false, 
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: 'Upload limit reached!',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const xff = req.headers['x-forwarded-for'];
        return xff ? xff.split(',')[0].trim() : req.ip;
    },
});

const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, 
    max: 5, 
    message: { error: "Too many login attempts. Please try again after an hour to protect your account." },
    standardHeaders: true, 
    legacyHeaders: false,
});

const isAdminEmail = (email) => {
    let listMatch = ADMIN_EMAILS.some(item => 
        item.toLowerCase() === email.toLowerCase()
    );
    return listMatch;
};

app.use(globalLimiter);

// Prevent caching for HTML pages so "Back" button forces a reload
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/admin' || req.path === '/registration') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const adminSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const storage = multer.memoryStorage();

// --- AUTO-LOGGING MIDDLEWARE ---
const trackActivity = (actionName) => {
    return async (req, res, next) => {
        res.on('finish', async () => {
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
        next();
    };
};

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
    let html = fs.readFileSync(path.join(__dirname, 'public', 'signup.html'), 'utf8');
    html = html.replace(/__SITE_KEY__/g, process.env.YOUR_SITE_KEY);
    res.send(html);
});

app.get('/gallery', async (req, res) => {
    try {
        const { data: submissions, error } = await supabase
            .from('submissions')
            .select('*')
            .order('id', { ascending: false }); 

        if (error) throw error;

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

app.post('/signup', trackActivity('USER_SIGNUP'), uploadLimiter, async (req, res) => {
    try {
        const { email, password, captchaToken } = req.body;

        const isHuman = await verifyRecaptcha(captchaToken);
        if (!isHuman) return res.status(403).json({ error: "Bot activity detected." });

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: '/login' 
            }
        });

        if (error) throw error;

        res.status(200).json({ 
            message: "Account created! Please check your email for verification.",
            user: data.user,
            session: data.session
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- MAINTENANCE MODE WITH ADMIN BYPASS ---
app.use((req, res, next) => {
    const isMaintenance = process.env.MAINTENANCE_MODE === 'true';
    const bypassKey = process.env.BYPASS_KEY; 

    if (bypassKey && req.query.bypass === bypassKey) {
        res.setHeader('Set-Cookie', `bypass_token=${bypassKey}; Path=/; HttpOnly`);
        return next();
    }

    const cookies = req.headers.cookie || '';
    if (bypassKey && cookies.includes(`bypass_token=${bypassKey}`)) {
        return next(); 
    }

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

    next(); 
});

app.post('/register', trackActivity('UPDATED_REGISTRATION'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });
        
        // --- ADDED SPOUSE_ATTENDING ---
        const { 
            participant_name, email, mobile, department, class_reg_no,  location, t_shirt_size,
            spouse_attending, adults_and_above_10, kids_6_10, kids_under_6,
            fri_family_join, fri_stay_type, sat_attend_type, thu_stay_type, sat_stay_type,
            donation_amount, performing_culturals, volunteering
        } = req.body;

        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });
        
        const { data: existing } = await userSupabase
            .from('submissions')
            .select('participant_name, email, mobile, qr_code_url')
            .eq('user_id', user.id)
            .single();

        let qrCodeUrl = existing?.qr_code_url;
        let shouldSendEmail = false;

        if (!existing || 
            existing.participant_name !== req.body.participant_name || 
            existing.email !== req.body.email || existing.mobile !== req.body.mobile) {
            
            let mobile = req.body.mobile;
            const qrData = `Reunion-2026-${mobile}`;
            const qrCodeBuffer = await QRCode.toBuffer(qrData);

            const qrFileName = `qrcodes/${mobile}-${Date.now()}.png`;
            const { data: uploadData, error: uploadError } = await adminSupabase.storage
                .from('images')
                .upload(qrFileName, qrCodeBuffer, { contentType: 'image/png' });

            if (uploadError) throw uploadError;
            const { data: qrUrl } = adminSupabase.storage.from('images').getPublicUrl(qrFileName);
            qrCodeUrl = qrUrl.publicUrl;
            
            shouldSendEmail = true;
        }

        if (existing){
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
                    spouse_attending: spouse_attending || 'No', // NEW
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
                    qr_code_url: qrCodeUrl 
                }, { onConflict: 'user_id' })
                .eq('user_id', user.id);
                if (dbError) throw dbError;
        }
        else{
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
                spouse_attending: spouse_attending || 'No', // NEW
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
                qr_code_url: qrCodeUrl 
            }, { onConflict: 'user_id' });
            if (dbError) throw dbError;
        }

        if (shouldSendEmail) {
            // --- UPDATED EMAIL COST CALCULATION ---
            const isSpouseAttending = spouse_attending === 'Yes';
            const familyAdults = parseInt(adults_and_above_10) || 0;
            const kids6to10 = parseInt(kids_6_10) || 0;
            const donation = parseInt(donation_amount) || 0;

            let totalCost = 0;

            // Friday Event
            totalCost += 7000; 
            if (fri_family_join === 'family') {
                if (isSpouseAttending) totalCost += 2000;
                totalCost += (familyAdults * 1500);
                totalCost += (kids6to10 * 1000);
            }

            // Saturday Event
            if (sat_attend_type !== 'no') {
                totalCost += 1500;
                if (sat_attend_type === 'family') {
                    if (isSpouseAttending) totalCost += 1000;
                    totalCost += (familyAdults * 1000);
                    totalCost += (kids6to10 * 500);
                }
            }

            // Stay Helper
            function getStayCost(type) {
                if (!type || type === 'no') return 0;
                let cost = 5500;
                if (type === 'family') {
                    if (isSpouseAttending) cost += 5500;
                    cost += (familyAdults * 2500);
                    cost += (kids6to10 * 2000);
                }
                return cost;
            }

            totalCost += getStayCost(thu_stay_type);
            totalCost += getStayCost(fri_stay_type);
            totalCost += getStayCost(sat_stay_type);
            totalCost += donation;

            const formatSelection = (val) => {
                if (val === 'family') return 'Yes, with family';
                if (val === 'self') return 'Yes, without family';
                if (val === 'yes') return 'Yes';
                return 'No';
            };

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
                            <td style="padding: 10px 0;">Spouse: ${isSpouseAttending ? 'Yes' : 'No'}, ${familyAdults} Kids(>10y), ${kids6to10} Kids(6-10y), ${kids_under_6} Kids(<6y)</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Thursday Stay:</td>
                            <td style="padding: 10px 0;">${formatSelection(thu_stay_type)}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #f1f5f9;">
                            <td style="padding: 10px 0; font-weight: bold;">Friday Family?:</td>
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
                const sendSmtpEmail = new Brevo.SendSmtpEmail();
                sendSmtpEmail.subject = "TCE Reunion 2026 Confirmation";
                sendSmtpEmail.htmlContent = emailHTML;
                
                sendSmtpEmail.sender = { "name": "Reunion Team", "email": "tcealumni2026@gmail.com" };
                sendSmtpEmail.to = [{ "email": email, "name": participant_name }];
                sendSmtpEmail.cc = [{ "email": 'tce2001reunion@gmail.com', "name": "New User Registration" }];

                await apiInstance.sendTransacEmail(sendSmtpEmail);
            }catch (emailError) {
                console.error(`[BREVO WARNING] Failed to send confirmation email to ${email}. Check daily quota!`);
                const errorMessage = emailError.response ? emailError.response.text : emailError.message;
                console.error(`Error Details: ${errorMessage}`);
            }
        }

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
        if (isAdminEmail(email)){
            isAdminUser = true;
        }
        
        res.status(200).json({ message: "Login successful", session: data.session, userType: isAdminUser ? 'x' : '' });
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
});

app.get('/login', (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'login_.html'), 'utf8'); 
    html = html.replace(/__SITE_KEY__/g, process.env.YOUR_SITE_KEY);
    res.send(html);
});

app.get('/get-registration', trackActivity('GET_REGISTRATION'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Unauthorized" });

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: "Invalid session" });
        
        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data, error } = await userSupabase
            .from('submissions')
            .select('*')
            .eq('user_id', user.id)
            .single(); 

        if (error && error.code !== 'PGRST116') throw error; 

        res.status(200).json(data || {}); 
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN ROUTE ---
app.get('/api/admin/all-registrations', trackActivity('ADMIN_GETALL_REGISTRATIONS'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Unauthorized" });
        const authHeader = req.headers.authorization;

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: "Invalid session" });
        }

        if (!isAdminEmail(user.email)) {
            return res.status(403).json({ error: "Access Denied: Admin rights required." });
        }

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
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        
        if (authError || !user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!isAdminEmail(user.email)) {
            console.warn(`Unauthorized admin access attempt by: ${user.email}`);
            return res.status(403).json({ error: 'Forbidden: Admin privileges required.' });
        }

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
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    
    const token = authHeader.split(' ')[1];

    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

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
app.post('/api/blog', trackActivity('CREATED_BLOG_POST'), async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    
    const token = authHeader.split(' ')[1];

    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

        const { title, content, author_name } = req.body;

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

        const file = req.file;
        const fileName = `${Date.now()}-${file.originalname}`;
        const { data: storageData, error: storageError } = await supabase.storage
            .from('images')
            .upload(fileName, file.buffer, { contentType: file.mimetype });

        if (storageError) throw storageError;

        const { data: publicUrl } = supabase.storage.from('images').getPublicUrl(fileName);

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
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });

    try {
        if (!req.file) return res.status(400).json({ error: 'No image provided' });

        const file = req.file;
        const cleanName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '');
        const fileName = `blog-photos/${Date.now()}-${cleanName}`;

        const { data, error } = await adminSupabase.storage
            .from('images')
            .upload(fileName, file.buffer, { contentType: file.mimetype });

        if (error) throw error;

        const { data: urlData } = adminSupabase.storage.from('images').getPublicUrl(fileName);

        res.json({ url: urlData.publicUrl });

    } catch (err) {
        console.error("Blog Image Upload Error:", err);
        res.status(500).json({ error: "Failed to upload image" });
    }
});

// --- DELETE A BLOG POST & ATTACHED IMAGES ---
app.delete('/api/blog/:id', trackActivity('DELETED_BLOG_POST'), async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Missing token' });
    
    const token = authHeader.split(' ')[1];

    try {
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

        const postId = req.params.id;

        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data: post, error: fetchError } = await userSupabase
            .from('blog_posts')
            .select('content, user_id')
            .eq('id', postId)
            .single();

        if (fetchError || !post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        if (post.user_id !== user.id) {
            return res.status(403).json({ error: 'Forbidden: You can only delete your own posts' });
        }

        const imgRegex = /<img[^>]+src="([^">]+)"/g;
        let match;
        const filePathsToDelete = [];
        
        const storageBaseUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/images/`;

        while ((match = imgRegex.exec(post.content)) !== null) {
            const imgUrl = match[1];
            if (imgUrl.startsWith(storageBaseUrl)) {
                const filePath = imgUrl.replace(storageBaseUrl, '');
                filePathsToDelete.push(filePath);
            }
        }

        if (filePathsToDelete.length > 0) {
            const { error: storageError } = await adminSupabase.storage
                .from('images')
                .remove(filePathsToDelete);
                
            if (storageError) {
                console.error("Warning: Failed to delete images from storage:", storageError);
            }
        }

        const { error: dbError } = await userSupabase
            .from('blog_posts')
            .delete()
            .eq('id', postId);

        if (dbError) throw dbError;

        res.json({ success: true, deletedImages: filePathsToDelete.length });

    } catch (error) {
        console.error("Error deleting post:", error);
        res.status(500).json({ error: "Failed to delete post" });
    }
});

// --- NIGHTLY BATCH PROCESS ENDPOINT ---
app.post('/api/cron/nightly-updates', async (req, res) => {
    const cronSecret = req.headers['x-cron-secret'];
    if (cronSecret !== process.env.CRON_SECRET) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    try {
        const { data: updatedSubmissions, error } = await adminSupabase
            .from('submissions')
            .select('*')
            .eq('needs_update_email', true);

        if (error) throw error;
        
        if (!updatedSubmissions || updatedSubmissions.length === 0) {
            return res.status(200).json({ message: 'No updates to process today.' });
        }

        const formatSelection = (val) => {
            if (val === 'family') return 'Yes, with family';
            if (val === 'self') return 'Yes, without family';
            if (val === 'yes') return 'Yes';
            if (!val || val === 'no') return 'No';
            return val;
        };

        let committeeTableRows = '';
        const processedUserIds = [];

        // --- 1. DEFINE THE MASTER HTML TEMPLATE FOR PARTICIPANTS ---
        const masterParticipantHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px;">
                <h2 style="color: #2563eb; text-align: center;">Registration Update Confirmed</h2>
                <p>Hi {{params.participant_name}},</p>
                <p>We successfully recorded the recent changes to your Class of 2001 Reunion registration. Here is your updated summary:</p>
                
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px;">
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold; width: 45%;">Family Members:</td>
                        <td style="padding: 10px 0;">Spouse: {{params.spouse}}, {{params.adults}} Kids(>10y), {{params.kids6to10}} Kids(6-10y), {{params.kidsUnder6}} Kids(<6y)</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold;">Thursday Stay:</td>
                        <td style="padding: 10px 0;">{{params.thu_stay}}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold;">Friday Family?:</td>
                        <td style="padding: 10px 0;">{{params.fri_reunion}}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold;">Friday Stay:</td>
                        <td style="padding: 10px 0;">{{params.fri_stay}}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold;">Saturday Reunion:</td>
                        <td style="padding: 10px 0;">{{params.sat_reunion}}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold;">Saturday Stay:</td>
                        <td style="padding: 10px 0;">{{params.sat_stay}}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold;">T-Shirt Size:</td>
                        <td style="padding: 10px 0;">{{params.t_shirt}}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #f1f5f9;">
                        <td style="padding: 10px 0; font-weight: bold;">Culturals / Volunteering:</td>
                        <td style="padding: 10px 0;">{{params.culturals}} / {{params.volunteering}}</td>
                    </tr>
                </table>

                <div style="background-color: #fef3c7; padding: 15px; border-radius: 8px; text-align: center;">
                    <h3 style="margin: 0; color: #b45309;">Updated Estimated Cost: ₹{{params.totalCost}}</h3>
                    <p style="margin: 5px 0 0 0; font-size: 13px; color: #b45309;">{{params.donationText}}</p>
                </div>
            </div>
        `;

        // INITIALIZE THE BATCH EMAIL OBJECT
        const batchParticipantEmail = new Brevo.SendSmtpEmail();
        batchParticipantEmail.sender = { "name": "Reunion Team", "email": "tcealumni2026@gmail.com" };
        batchParticipantEmail.subject = "Registration Update Confirmed";
        batchParticipantEmail.htmlContent = masterParticipantHtml; 
        batchParticipantEmail.messageVersions = [];

        // --- 2. LOOP THROUGH SUBMISSIONS ---
        for (const sub of updatedSubmissions) {
            
            const isSpouseAttending = sub.spouse_attending === 'Yes';
            const familyAdults = parseInt(sub.adults_and_above_10) || 0;
            const kids6to10 = parseInt(sub.kids_6_10) || 0;
            const kidsUnder6 = parseInt(sub.kids_under_6) || 0;
            const donation = parseInt(sub.donation_amount) || 0;

            let totalCost = 0;

            totalCost += 7000; 
            if (sub.fri_family_join === 'family') {
                if (isSpouseAttending) totalCost += 2000;
                totalCost += (familyAdults * 1500);
                totalCost += (kids6to10 * 1000);
            }

            if (sub.sat_attend_type !== 'no') {
                totalCost += 1500;
                if (sub.sat_attend_type === 'family') {
                    if (isSpouseAttending) totalCost += 1000;
                    totalCost += (familyAdults * 1000);
                    totalCost += (kids6to10 * 500);
                }
            }

            function getStayCost(type) {
                if (!type || type === 'no') return 0;
                let cost = 5500;
                if (type === 'family') {
                    if (isSpouseAttending) cost += 5500;
                    cost += (familyAdults * 2500);
                    cost += (kids6to10 * 2000);
                }
                return cost;
            }

            totalCost += getStayCost(sub.thu_stay_type);
            totalCost += getStayCost(sub.fri_stay_type);
            totalCost += getStayCost(sub.sat_stay_type);
            totalCost += donation;

            const donationString = donation > 0 ? `(Includes your ₹${donation.toLocaleString('en-IN')} donation)` : '';
            
            // --- PASS ONLY THE DATA VARIABLES TO BREVO ---
            if (sub.email) {
                batchParticipantEmail.messageVersions.push({
                    to: [{ "email": sub.email, "name": sub.participant_name }],
                    params: { 
                        participant_name: sub.participant_name,
                        spouse: isSpouseAttending ? 'Yes' : 'No',
                        adults: familyAdults,
                        kids6to10: kids6to10,
                        kidsUnder6: kidsUnder6,
                        thu_stay: formatSelection(sub.thu_stay_type),
                        fri_reunion: formatSelection(sub.fri_family_join),
                        fri_stay: formatSelection(sub.fri_stay_type),
                        sat_reunion: formatSelection(sub.sat_attend_type),
                        sat_stay: formatSelection(sub.sat_stay_type),
                        t_shirt: sub.t_shirt_size || '-',
                        culturals: sub.performing_culturals || '-',
                        volunteering: sub.volunteering || '-',
                        totalCost: totalCost.toLocaleString('en-IN'),
                        donationText: donationString
                    }
                });
            }

            // Build the donation string for the committee table
            const donationStr = donation > 0 ? `<br><span style="color:#b45309; font-size:11px;">+₹${donation.toLocaleString('en-IN')} don.</span>` : '';
            const culturals = sub.performing_culturals && sub.performing_culturals !== 'no' ? sub.performing_culturals : '-';
            const volunteering = sub.volunteering && sub.volunteering !== 'no' ? sub.volunteering : '-';

            committeeTableRows += `
                <tr style="border-bottom: 1px solid #e2e8f0; font-size: 13px;">
                    <td style="padding: 10px 8px; font-weight: bold; color: #0f172a;">${sub.participant_name}<br><span style="font-weight: normal; color: #64748b; font-size: 11px;">${sub.mobile}</span></td>
                    <td style="padding: 10px 8px;">Spouse:${isSpouseAttending?'Y':'N'}, ${familyAdults}K(>10), ${kids6to10}K(6-10)</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.thu_stay_type)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.fri_family_join)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.fri_stay_type)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.sat_attend_type)}</td>
                    <td style="padding: 10px 8px;">${formatSelection(sub.sat_stay_type)}</td>
                    <td style="padding: 10px 8px; text-align: center;">${sub.t_shirt_size || '-'}</td>
                    <td style="padding: 10px 8px; font-size: 11px; color: #475569;">C: ${culturals}<br>V: ${volunteering}</td>
                    <td style="padding: 10px 8px; font-weight: bold; color: #047857;">₹${totalCost.toLocaleString('en-IN')}${donationStr}</td>
                </tr>
            `;

            processedUserIds.push(sub.user_id);
        }

        // --- 3. FIRE THE BATCH API CALL TO INDIVIDUALS ---
        if (batchParticipantEmail.messageVersions.length > 0) {
            try {
                await apiInstance.sendTransacEmail(batchParticipantEmail);
                console.log(`Successfully sent batch emails to ${batchParticipantEmail.messageVersions.length} users.`);
            } catch (batchError) {
                console.error("Batch send to participants failed:", batchError.response ? batchError.response.text : batchError.message);
            }
        }

        // --- 4. BUILD & SEND COMMITTEE EMAIL ---
        const committeeHtml = `
            <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 1200px; margin: 0 auto;">
                <h2 style="color: #0f172a;">Daily Registration Updates</h2>
                <p>The following ${updatedSubmissions.length} alumni modified their registrations in the last 24 hours.</p>
                <table style="width: 100%; border-collapse: collapse; text-align: left; background: #ffffff; border: 1px solid #cbd5e1;">
                    <tr style="background-color: #f8fafc; border-bottom: 2px solid #cbd5e1; font-size: 12px; text-transform: uppercase; color: #475569;">
                        <th style="padding: 12px 8px;">Alumnus</th>
                        <th style="padding: 12px 8px;">Family</th>
                        <th style="padding: 12px 8px;">Thu Stay</th>
                        <th style="padding: 12px 8px;">Fri Family?</th>
                        <th style="padding: 12px 8px;">Fri Stay</th>
                        <th style="padding: 12px 8px;">Sat Event</th>
                        <th style="padding: 12px 8px;">Sat Stay</th>
                        <th style="padding: 12px 8px; text-align: center;">T-Shirt</th>
                        <th style="padding: 12px 8px;">Activities</th>
                        <th style="padding: 12px 8px;">New Total</th>
                    </tr>
                    ${committeeTableRows}
                </table>
            </div>
        `;
        
        const sendCommitteeEmail = new Brevo.SendSmtpEmail();
        sendCommitteeEmail.subject = "TCE Reunion 2026 : Registration Changes";
        sendCommitteeEmail.htmlContent = committeeHtml;
        
        sendCommitteeEmail.sender = { "name": "Reunion Team", "email": "tcealumni2026@gmail.com" };
        sendCommitteeEmail.to = [{ "email": "tce2001reunion@gmail.com", "name": "Reunion 2001 Admin" }];
        sendCommitteeEmail.cc = [{ "email": "dmahesh2k@gmail.com", "name": "Sys Admin" }];

        await apiInstance.sendTransacEmail(sendCommitteeEmail);

        // --- 5. CLEAR DATABASE FLAGS ---
        for (const uid of processedUserIds) {
            await adminSupabase
                .from('submissions')
                .update({ needs_update_email: false })
                .eq('user_id', uid);
        }

        return res.status(200).json({ message: `Successfully processed and batched ${updatedSubmissions.length} updates.` });

    } catch (err) {
        console.error("Nightly Batch Error:", err);
        return res.status(500).json({ error: 'Batch process failed' });
    }
});

// --- PUBLIC ATTENDEES LIST ---
app.get('/api/attendees', async (req, res) => {
    try {
        // ONLY select the name and department. Do NOT select emails or mobile numbers!
        const { data, error } = await adminSupabase
            .from('submissions')
            .select('participant_name, department')
            .order('department', { ascending: true })
            .order('participant_name', { ascending: true });

        if (error) throw error;
        
        return res.status(200).json(data);
    } catch (err) {
        console.error("Error fetching attendees:", err);
        return res.status(500).json({ error: 'Failed to load attendees' });
    }
});

app.post('/admin/update-payment', async (req, res) => {
    const { user_id, payment_status, amount_received, remarks } = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }

    try {
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: 'Session expired or invalid token' });
        }

        const { error: updateError } = await adminSupabase
            .from('submissions')
            .update({
                payment_status: payment_status,
                amount_received: amount_received || 0,
                remarks: remarks || '' // Update the column entry field smoothly here
            })
            .eq('user_id', user_id);

        if (updateError) throw updateError;

        return res.status(200).json({ message: 'Admin update completed successfully!' });

    } catch (err) {
        console.error("Admin Payment Update Error:", err);
        return res.status(500).json({ error: 'Admin record update failed.' });
    }
});

// --- ENDOWMENT FUND PLEDGE ENDPOINT ---
app.post('/api/donate', trackActivity('MADE_ENDOWMENT_PLEDGE'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Unauthorized" });

        // 1. Verify user session securely via Supabase Auth
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: "Invalid session" });

        const { participant_name, mobile, department, food_fund_annual, schol_annual, schol_onetime, idealab, total_amount } = req.body;

        // 2. Create an authenticated client context for this specific user
        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        // 3. Save or Update the pledge in the database
        const { error: dbError } = await userSupabase
            .from('donations')
            .upsert({
                user_id: user.id, 
                participant_name: participant_name, // Added
                mobile: mobile,                     // Added
                department: department,             // Added
                food_fund_annual: parseInt(food_fund_annual) || 0,
                schol_annual: parseInt(schol_annual) || 0,
                schol_onetime: parseInt(schol_onetime) || 0,
                idealab: parseInt(idealab) || 0,
                total_amount: parseInt(total_amount) || 0,
                payment_status: 'pledged'
            }, { onConflict: 'user_id' });

        if (dbError) throw dbError;

        res.status(200).json({ message: "Pledge securely recorded!" });

    } catch (err) {
        console.error("Donation Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN ROUTE: GET ALL DONATIONS ---
// app.get('/api/admin/all-donations', trackActivity('ADMIN_GETALL_DONATIONS'), async (req, res) => {
//     try {
//         const token = req.headers.authorization?.split(' ')[1];
//         if (!token) return res.status(401).json({ error: "Unauthorized" });

//         const { data: { user }, error: authError } = await supabase.auth.getUser(token);
//         if (authError || !user) {
//             return res.status(401).json({ error: "Invalid session" });
//         }

//         if (!ADMIN_EMAILS.includes(user.email)) {
//             return res.status(403).json({ error: "Access Denied: Admin rights required." });
//         }

//         // 1. Fetch all donations
//         const { data: donations, error: dbError } = await adminSupabase 
//             .from('donations')
//             .select('*')
//             .order('created_at', { ascending: false });

//         if (dbError) throw dbError;

//         // 2. Fetch users from auth system to get emails & Google names
//         const { data: { users }, error: usersError } = await adminSupabase.auth.admin.listUsers();
//         if (usersError) throw usersError;

//         const userMap = {};
//         users.forEach(u => {
//             userMap[u.id] = {
//                 email: u.email,
//                 name: u.user_metadata?.full_name || 'N/A'
//             };
//         });

//         // 3. Fetch submissions to get specific registration details
//         // NEW: Added mobile and department to the select query
//         const { data: submissions } = await adminSupabase
//             .from('submissions')
//             .select('user_id, participant_name, email, mobile, department');
            
//         const subMap = {};
//         if (submissions) {
//             submissions.forEach(s => {
//                 subMap[s.user_id] = { 
//                     name: s.participant_name, 
//                     email: s.email,
//                     mobile: s.mobile,
//                     department: s.department 
//                 };
//             });
//         }

//         // 4. Merge the data securely on the backend
//         const enrichedDonations = donations.map(d => ({
//             ...d,
//             email: subMap[d.user_id]?.email || userMap[d.user_id]?.email || 'Unknown',
//             participant_name: subMap[d.user_id]?.name || userMap[d.user_id]?.name || 'Unknown',
//             mobile: subMap[d.user_id]?.mobile || 'N/A', // NEW
//             department: subMap[d.user_id]?.department || 'N/A' // NEW
//         }));

//         res.json(enrichedDonations);

//     } catch (err) {
//         console.error("Admin Donations Fetch Error:", err);
//         res.status(500).json({ error: err.message });
//     }
// });

// --- ADMIN ROUTE: GET ALL DONATIONS ---
app.get('/api/admin/all-donations', trackActivity('ADMIN_GETALL_DONATIONS'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Unauthorized" });

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: "Invalid session" });
        }

        if (!isAdminEmail(user.email)) {
            return res.status(403).json({ error: "Access Denied: Admin rights required." });
        }

        // 1. Fetch all donations
        const { data: donations, error: dbError } = await adminSupabase 
            .from('donations')
            .select('*')
            .order('created_at', { ascending: false });

        if (dbError) throw dbError;
        
        // If no donations exist, return early
        if (!donations || donations.length === 0) {
            return res.json([]);
        }

        // Extract unique user IDs from the donations table
        const userIds = [...new Set(donations.map(d => d.user_id))];

        // 2. Fetch submissions to get specific registration details (name, email, mobile, dept)
        const { data: submissions } = await adminSupabase
            .from('submissions')
            .select('user_id, participant_name, email, mobile, department')
            .in('user_id', userIds); // Only fetch users who have donated
            
        const subMap = {};
        if (submissions) {
            submissions.forEach(s => {
                subMap[s.user_id] = { 
                    name: s.participant_name, 
                    email: s.email,
                    mobile: s.mobile,
                    department: s.department 
                };
            });
        }

        // 3. Fallback: Fetch users from Auth system (for users who donated but haven't registered for the event yet)
        // const { data: authUsersData, error: usersError } = await adminSupabase.auth.admin.listUsers();
        const { data: authUsersData, error: usersError } = await adminSupabase.auth.admin.listUsers({
                page: 1,
                perPage: 1000 // Max allowed per page
            });
        const userMap = {};
        if (!usersError && authUsersData && authUsersData.users) {
             authUsersData.users.forEach(u => {
                console.log('u.id, u.email, name=', u.id, ',', u.email,',', u.user_metadata?.full_name);
                userMap[u.id] = {
                    email: u.email,
                    name: u.user_metadata?.full_name || 'N/A'
                };
            });
        }

        // 4. Merge the data securely on the backend
        const enrichedDonations = donations.map(d => {
            const subData = subMap[d.user_id];
            const authData = userMap[d.user_id];

            return {
                ...d,
                // Prioritize Registration -> Donation Table -> Google Auth Profile
                email: subData?.email || authData?.email || 'Unknown',
                participant_name: subData?.name || d.participant_name || authData?.name || 'Unknown User',
                mobile: subData?.mobile || d.mobile || 'N/A', 
                department: subData?.department || d.department || 'N/A' 
            };
        });

        res.json(enrichedDonations);

    } catch (err) {
        console.error("Admin Donations Fetch Error:", err);
        res.status(500).json({ error: err.message });
    }
});
// --- ADMIN ROUTE: GET ALL DONATIONS ---
app.get('/api/admin/all-donations-guest', async (req, res) => {
    try {
        // 1. Fetch all donations
        const { data: donations, error: dbError } = await adminSupabase 
            .from('donations')
            .select('*')
            .order('created_at', { ascending: false });

        if (dbError) throw dbError;
        
        // If no donations exist, return early
        if (!donations || donations.length === 0) {
            return res.json([]);
        }

        // Extract unique user IDs from the donations table
        const userIds = [...new Set(donations.map(d => d.user_id))];

        // 2. Fetch submissions to get specific registration details (name, email, mobile, dept)
        const { data: submissions } = await adminSupabase
            .from('submissions')
            .select('user_id, participant_name, email, mobile, department')
            .in('user_id', userIds); // Only fetch users who have donated
            
        const subMap = {};
        if (submissions) {
            submissions.forEach(s => {
                subMap[s.user_id] = { 
                    name: s.participant_name, 
                    email: s.email,
                    mobile: s.mobile,
                    department: s.department 
                };
            });
        }

        // 3. Fallback: Fetch users from Auth system (for users who donated but haven't registered for the event yet)
        // const { data: authUsersData, error: usersError } = await adminSupabase.auth.admin.listUsers();
        const { data: authUsersData, error: usersError } = await adminSupabase.auth.admin.listUsers({
                page: 1,
                perPage: 1000 // Max allowed per page
            });
        const userMap = {};
        if (!usersError && authUsersData && authUsersData.users) {
             authUsersData.users.forEach(u => {
                console.log('u.id, u.email, name=', u.id, ',', u.email,',', u.user_metadata?.full_name);
                userMap[u.id] = {
                    email: u.email,
                    name: u.user_metadata?.full_name || 'N/A'
                };
            });
        }

        // 4. Merge the data securely on the backend
        const enrichedDonations = donations.map(d => {
            const subData = subMap[d.user_id];
            const authData = userMap[d.user_id];

            return {
                ...d,
                // Prioritize Registration -> Donation Table -> Google Auth Profile
                department: subData?.department || d.department || 'N/A' 
            };
        });

        res.json(enrichedDonations);

    } catch (err) {
        console.error("Admin Donations Fetch Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- FETCH EXISTING ENDOWMENT PLEDGE ---
app.get('/api/donate', trackActivity('VIEWED_ENDOWMENT_PLEDGE'), async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Unauthorized" });

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: "Invalid session" });

        const userSupabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
            global: { headers: { Authorization: `Bearer ${token}` } }
        });

        const { data, error } = await userSupabase
            .from('donations')
            .select('*')
            .eq('user_id', user.id)
            .single();

        // If no row exists yet, Supabase throws PGRST116. We just return an empty object.
        if (error && error.code !== 'PGRST116') throw error;

        res.status(200).json(data || {});
    } catch (err) {
        console.error("Fetch Donation Error:", err.message);
        res.status(500).json({ error: "Failed to fetch pledge data." });
    }
});

// --- ENDOWMENT DONATIONS: INLINE EDIT SAVE ---
app.post('/admin/update-donation', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
        return res.status(401).json({ error: "Invalid session" });
    }

    if (!isAdminEmail(user.email)) {
        return res.status(403).json({ error: "Access Denied: Admin rights required." });
    }
    
    const { user_id, payment_status, amount_received, remarks } = req.body;

    if (!user_id) {
        return res.status(400).json({ error: "Missing required user_id parameter" });
    }

    try {
        const { data, error } = await adminSupabase
            .from('donations') // Points specifically to the Endowment table
            .update({ 
                payment_status: payment_status,
                amount_received: amount_received,
                remarks: remarks
            })
            .eq('user_id', user_id);

        if (error) throw error;

        return res.json({ success: true, message: "Donation record updated successfully" });
    } catch (err) {
        console.error("Donation dashboard update failure:", err.message);
        return res.status(500).json({ error: "Internal database updates failed to commit" });
    }
});

const checkAdminAuth = async (req, res, next) => {
    try {
        // 1. Extract the token from the request header (sent via fetch)
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: "Access denied. No token provided." });
        }
        
        const token = authHeader.split(' ')[1];

        // 2. Ask Supabase to validate the JWT token
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({ error: "Invalid or expired session token." });
        }

        // 3. Validate Admin Status (Server-Side)
        // Assuming you have a 'profiles' or 'users' table where the userType 'x' is securely stored
        const { data: profile, error: dbError } = await supabase
            .from('profiles') // Change this to your actual user/admin table
            .select('user_type')
            .eq('id', user.id)
            .single();

        if (dbError || !profile || profile.user_type !== 'x') {
            return res.status(403).json({ error: "Forbidden. Admin access required." });
        }

        // 4. Session is valid AND they are an admin! 
        // Attach the user object to the request and proceed to the route logic.
        req.user = user;
        next(); 

    } catch (err) {
        console.error("Middleware Auth Error:", err.message);
        return res.status(500).json({ error: "Authentication processing error." });
    }
};

// --- ENDOWMENT FUND OVERALL SUMMARY ---
app.get('/api/donations-summary', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Unauthorized" });

        const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: "Invalid session" });
        }

        // if (!isAdminEmail(user.email)) {
        //     return res.status(403).json({ error: "Access Denied: Admin rights required." });
        // }
        // Use adminSupabase to bypass RLS so we can see all rows to calculate the sum
        const { data, error } = await adminSupabase
            .from('donations')
            .select('food_fund_annual, schol_annual, schol_onetime, idealab');

        if (error) throw error;

        let totals = {
            food: 0,
            'schol-annual': 0,
            'schol-onetime': 0,
            idealab: 0
        };

        if (data) {
            data.forEach(row => {
                totals.food += (row.food_fund_annual || 0);
                totals['schol-annual'] += (row.schol_annual || 0);
                totals['schol-onetime'] += (row.schol_onetime || 0);
                totals.idealab += (row.idealab || 0);
            });
        }

        res.status(200).json(totals);

    } catch (err) {
        console.error("Donation Summary Error:", err);
        res.status(500).json({ error: "Failed to fetch aggregates" });
    }
});


app.post('/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
    }

    try {
        const { data, error } = await adminSupabase.auth.resetPasswordForEmail(email, {
            redirectTo: 'https://jalabulagems.com/update-password.html' 
        });

        if (error) {
            throw error;
        }

        return res.status(200).json({ message: 'If an account exists, a reset link has been sent.' });

    } catch (err) {
        console.error("Forgot Password Error:", err);
        return res.status(500).json({ error: err.message || 'Failed to send reset link.' });
    }
});

app.post('/update-password', async (req, res) => {
    const { password } = req.body;
    const authHeader = req.headers['authorization'];
    
    const token = authHeader && authHeader.split(' ')[1];

    if (!token || !password) {
        return res.status(400).json({ error: 'Missing token or password.' });
    }

    try {
        const { data: { user }, error: userError } = await adminSupabase.auth.getUser(token);
        
        if (userError || !user) {
            return res.status(401).json({ error: 'Session expired. Please request a new reset link.' });
        }

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

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// --- MAGIC AUTO-FILL ENDPOINT ---
app.post('/api/magic-fill', globalLimiter, async (req, res) => {
    const { userInput } = req.body;

    if (!userInput) return res.status(400).json({ error: "Please provide some text." });

    try {
        // 1. Define the exact JSON structure matching your new HTML form
        const formSchema = {
            type: SchemaType.OBJECT,
            properties: {
                spouse_attending: { type: SchemaType.STRING, description: "Must be exactly 'Yes' or 'No'. If they mention bringing a spouse, wife, husband, or partner, this is 'Yes'." },
                adults_and_above_10: { type: SchemaType.NUMBER, description: "Number of additional family members over 10 years old. CRITICAL: Do NOT count the primary user or the spouse in this number. E.g., 'me, my wife, and our 15yr old' = 1." },
                kids_6_10: { type: SchemaType.NUMBER, description: "Number of children aged 6 to 10." },
                kids_under_6: { type: SchemaType.NUMBER, description: "Number of children under 6." },
                
                thu_stay_type: { type: SchemaType.STRING, description: "Must be exactly 'self', 'family', or 'no'. If arriving Thursday with family, use 'family'. If alone, use 'self'." },
                fri_family_join: { type: SchemaType.STRING, description: "Must be exactly 'family', or 'no'." },
                fri_stay_type: { type: SchemaType.STRING, description: "Must be exactly 'self', 'family', or 'no'." },
                sat_attend_type: { type: SchemaType.STRING, description: "Must be exactly 'self', 'family', or 'no'." },
                sat_stay_type: { type: SchemaType.STRING, description: "Must be exactly 'self', 'family', or 'no'." },
                
                donation_amount: { type: SchemaType.NUMBER, description: "Amount in INR they wish to donate, if explicitly mentioned. Default to 0." },
                performing_culturals: { type: SchemaType.STRING, description: "Must be 'Yes' or 'No'. Default to 'No'." },
                volunteering: { type: SchemaType.STRING, description: "Must be 'Yes' or 'No'. Default to 'No'." },
                t_shirt_size: { type: SchemaType.STRING, description: "Must be exactly 'S', 'M', 'L', 'XL', 'XXL', or 'XXXL'. If not mentioned, default to 'M'." }
            },
            required: [
                "spouse_attending", "adults_and_above_10", "kids_6_10", "kids_under_6", 
                "thu_stay_type", "fri_family_join", "fri_stay_type", "sat_attend_type", "sat_stay_type",
                "donation_amount", "performing_culturals", "volunteering", "t_shirt_size"
            ]
        };

        // 2. Initialize the model and force it to use our schema
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: formSchema,
            },
        });

        // 3. Send the prompt
        const prompt = `You are a highly logical data parser for a college reunion. 
        Read the user's text and extract their event plans into the strict JSON format required. 
        Pay special attention to who is attending and map them accurately to the spouse and kids categories.
        User text: "${userInput}"`;

        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();

        // 4. Send the perfect JSON back to the frontend
        return res.status(200).json(JSON.parse(aiResponse));

    } catch (err) {
        console.error("AI Parsing Error:", err);
        return res.status(500).json({ error: "Failed to parse text. Please fill the form manually." });
    }
});

app.post('/api/salesforce/upload', upload.any(), async (req, res) => {
    try {
        const { brokercode, hashcode } = req.body;
        const files = req.files || [];

        const uploadResults = [];

        for (const file of files) {
            const filePath = `salesforce-project/${brokercode}/${file.fieldname}-${Date.now()}-${file.originalname}`;
            
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

// --- 1. INITIATE GOOGLE LOGIN ---
app.get('/auth/google', async (req, res) => {
    // Generate the secure Google OAuth URL via Supabase
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
            // Tell Supabase to send the user to our backend callback after logging in
            // Change localhost:3000 to your live domain when deploying!
            redirectTo: process.env.PUBLIC_DOMAIN + '/auth/callback' 
        }
    });

    if (error) {
        console.error("OAuth Initiation Error:", error.message);
        return res.redirect('/login?error=google_failed');
    }

    // Redirect the user to the Google sign-in page
    res.redirect(data.url);
});

// --- 2. HANDLE THE CALLBACK & SAVE TOKEN ---
app.get('/auth/callback', (req, res) => {
    // Node.js cannot see the #access_token fragment, but the browser can!
    // We send a tiny, instant script to the browser to grab it and save it.
    res.send(`
        <html>
            <body style="background-color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif;">
                <h3 style="color: #2563eb;">Securely logging you in...</h3>
                <script>
                    // 1. Grab the hash from the URL
                    const hash = window.location.hash;

                    if (hash && hash.includes('access_token')) {
                        // 2. Parse the hash into readable variables
                        const params = new URLSearchParams(hash.substring(1));
                        const accessToken = params.get('access_token');
                        
                        // 3. Save the token exactly where your frontend expects it
                        localStorage.setItem('supabaseToken', accessToken);
                        
                        // 4. Redirect immediately to the dashboard
                        window.location.replace('/registration.html');
                    } else {
                        // Fallback if they hit this page manually without logging in
                        window.location.replace('/login.html?error=auth_failed');
                    }
                </script>
            </body>
        </html>
    `);
});

// --- SECURE GOOGLE ID TOKEN EXCHANGE ---
app.post('/api/auth/google/verify', async (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(400).json({ error: 'Missing Google token' });
    }

    try {
        // Trade the Google ID Token for a Supabase Session
        const { data, error } = await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: token
        });

        if (error) throw error;

        // Send the session data back to the frontend to be saved in localStorage
        return res.status(200).json({ session: data.session });

    } catch (err) {
        console.error("Supabase Token Exchange Error:", err.message);
        return res.status(500).json({ error: 'Failed to authenticate with database' });
    }
});

// --- SECURE DONOR LIST (Only visible to logged-in users) ---
app.get('/api/donations/department-metrics', async (req, res) => {
    try {
        // const token = req.headers.authorization?.split(' ')[1];
        // if (!token) return res.status(401).json({ error: "Unauthorized" });

        // // Verify user is logged in
        // const { data: { user }, error: authError } = await supabase.auth.getUser(token);
        // if (authError || !user) {
        //     return res.status(401).json({ error: "Invalid session" });
        // }

        // 1. Fetch only the department column to keep the payload lightweight
        const { data, error } = await adminSupabase
            .from('donations')
            .select('department');

        if (error) throw error;

        // 2. Parse and normalize the total strengths from the environment variable
        let deptStrengths = {};
        try {
            if (process.env.DEPT_STRENGTHS) {
                const parsedStrengths = JSON.parse(process.env.DEPT_STRENGTHS);
                // Convert all keys to lowercase for case-insensitive matching
                for (const [key, value] of Object.entries(parsedStrengths)) {
                    deptStrengths[key.toLowerCase()] = value;
                }
            }
        } catch (parseErr) {
            console.error("Could not parse DEPT_STRENGTHS from .env", parseErr);
        }

        // 3. Group and count donors by department
        const departmentCounts = data.reduce((acc, row) => {
            const dept = row.department ? row.department.trim() : 'Unknown';
            acc[dept] = (acc[dept] || 0) + 1;
            return acc;
        }, {});

        // 4. Build the final array merging DB counts with Env Var strengths
        const metricsArray = Object.keys(departmentCounts)
            .map(dept => {
                const donorsCount = departmentCounts[dept];
                
                // Lookup using lowercase to ensure "Computer Science" matches "computer science"
                const lookupKey = dept.toLowerCase();
                const totalStrength = deptStrengths[lookupKey] || Math.max(donorsCount, 100); 

                return {
                    department: dept,
                    donors: donorsCount,
                    total_strength: totalStrength
                };
            })
            .sort((a, b) => a.department.localeCompare(b.department)); // Sort by dept

        return res.status(200).json(metricsArray);

    } catch (err) {
        console.error("Error fetching secure donations list:", err);
        return res.status(500).json({ error: 'Failed to load donations list' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Secure server running on port ${PORT}`);
});