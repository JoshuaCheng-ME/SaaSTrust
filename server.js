require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Resend } = require('resend');
const axios = require('axios');

const db = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

// ── Resend ──
const resend = new Resend(process.env.RESEND_API_KEY || 'resend_api_key_placeholder');

// ── Multer: proof screenshots ──
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (_, file, cb) => {
    const suffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'proof-' + suffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /jpeg|jpg|png|gif/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only image files allowed'), ok);
  }
});

// ── Multer: invoice files (admin upload) ──
const invoiceStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, 'public', 'invoices')),
  filename: (_, file, cb) => {
    const suffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'invoice-' + suffix + path.extname(file.originalname));
  }
});
const invoiceUpload = multer({
  storage: invoiceStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = /pdf|png|jpg|jpeg/.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Only PDF/images allowed'), ok);
  }
});

// ── Ensure upload directories ──
['public/uploads', 'public/invoices'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ── Init Database Tables ──
async function safeAlter(sql) {
  try {
    await db.execute(sql);
    console.log('  Migrated:', sql.substring(0, 60).replace(/\n/g, ' ') + '...');
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME' || e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_DUP_KEY')
      console.log('  Skip (exists):', sql.substring(0, 60).replace(/\n/g, ' '));
    else throw e;
  }
}

async function initDB() {
  try {
    // users
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        industry VARCHAR(100) NOT NULL,
        linkedin_profile VARCHAR(255),
        google_id VARCHAR(255) DEFAULT NULL,
        linkedin_id VARCHAR(255) DEFAULT NULL,
        b_name VARCHAR(100),
        b_role VARCHAR(100),
        b_company VARCHAR(100),
        b_website VARCHAR(255),
        b_platform_focus VARCHAR(255),
        b_contact VARCHAR(100),
        a_experience VARCHAR(50),
        a_daily_tools VARCHAR(255),
        a_country VARCHAR(100),
        a_payout_method VARCHAR(100),
        a_contact VARCHAR(100),
        account_status VARCHAR(50) DEFAULT 'Approved',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // campaigns
    await db.execute(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employer_id INT,
        product_name VARCHAR(255) NOT NULL,
        product_url VARCHAR(255) NOT NULL,
        target_industry VARCHAR(100) NOT NULL,
        target_platform ENUM('G2','Capterra','Trustpilot','Product Hunt','Other') NOT NULL,
        reviews_needed INT NOT NULL,
        gumroad_email VARCHAR(255) DEFAULT NULL,
        status VARCHAR(50) DEFAULT 'Pending Payments',
        invoice_url VARCHAR(255) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employer_id) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // applications
    await db.execute(`
      CREATE TABLE IF NOT EXISTS applications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reviewer_id INT,
        campaign_id INT,
        status VARCHAR(50) DEFAULT 'In Progress',
        screenshot_url VARCHAR(255) DEFAULT NULL,
        gift_card_code VARCHAR(255) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (reviewer_id) REFERENCES users(id),
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
        UNIQUE KEY unique_match (reviewer_id, campaign_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── MIGRATIONS: Add missing columns for existing tables ──
    console.log('Running schema migrations...');

    // users: new v3.1 columns
    await safeAlter(`ALTER TABLE users ADD COLUMN google_id VARCHAR(255) DEFAULT NULL`);
    await safeAlter(`ALTER TABLE users ADD COLUMN linkedin_id VARCHAR(255) DEFAULT NULL`);
    await safeAlter(`ALTER TABLE users ADD COLUMN b_name VARCHAR(100)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN b_role VARCHAR(100)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN b_company VARCHAR(100)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN b_website VARCHAR(255)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN b_platform_focus VARCHAR(255)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN b_contact VARCHAR(100)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN a_experience VARCHAR(50)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN a_daily_tools VARCHAR(255)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN a_country VARCHAR(100)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN a_payout_method VARCHAR(100)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN a_contact VARCHAR(100)`);
    await safeAlter(`ALTER TABLE users ADD COLUMN account_status VARCHAR(50) DEFAULT 'Approved'`);

    // campaigns: new v3.1 columns
    await safeAlter(`ALTER TABLE campaigns ADD COLUMN target_platform VARCHAR(50) NOT NULL DEFAULT 'G2'`);
    await safeAlter(`ALTER TABLE campaigns ADD COLUMN product_url VARCHAR(255) NOT NULL DEFAULT ''`);
    await safeAlter(`ALTER TABLE campaigns ADD COLUMN target_industry VARCHAR(100) NOT NULL DEFAULT ''`);
    await safeAlter(`ALTER TABLE campaigns ADD COLUMN reviews_needed INT NOT NULL DEFAULT 5`);
    await safeAlter(`ALTER TABLE campaigns ADD COLUMN gumroad_email VARCHAR(255) DEFAULT NULL`);
    await safeAlter(`ALTER TABLE campaigns ADD COLUMN invoice_url VARCHAR(255) DEFAULT NULL`);
    // Ensure target_platform is ENUM
    await safeAlter(`ALTER TABLE campaigns MODIFY COLUMN target_platform ENUM('G2','Capterra','Trustpilot','Product Hunt','Other') NOT NULL`);

    // applications: new v3.1 columns
    await safeAlter(`ALTER TABLE applications ADD COLUMN gift_card_code VARCHAR(255) DEFAULT NULL`);
    // unique key
    await safeAlter(`ALTER TABLE applications ADD UNIQUE KEY unique_match (reviewer_id, campaign_id)`);

    console.log('Migrations complete.');

    // Default admin
    const [rows] = await db.execute('SELECT id FROM users WHERE email = ?', ['admin@saastrust.net']);
    if (rows.length === 0) {
      await db.execute(
        `INSERT INTO users (email, password, role, industry, account_status)
         VALUES (?, ?, ?, ?, ?)`,
        ['admin@saastrust.net', bcrypt.hashSync('admin123', 10), 'admin', 'SaaS', 'Approved']
      );
      console.log('Default admin created: admin@saastrust.net / admin123');
    }

    console.log('Database initialized (v3.1 schema)');
  } catch (err) {
    console.error('DB init failed:', err);
    throw err;
  }
}

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'saastrust-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Guards ──
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role))
      return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// ── Resend Email Helper ──
async function sendGiftCardEmail(toEmail, code, productName) {
  try {
    await resend.emails.send({
      from: 'payouts@saastrust.net',
      to: toEmail,
      subject: 'Your SaaSTrust Payout is Ready!',
      html: `<div style="font-family:sans-serif;padding:20px;max-width:600px;border:1px solid #eaeaea;">
        <h2 style="color:#000;font-weight:800;letter-spacing:-0.05em;">SaaSTrust.net</h2>
        <p>Your G2/Capterra review submission has been successfully vetted and approved by our admin.</p>
        <div style="background:#f9f9f9;padding:15px;border-radius:4px;font-family:monospace;font-size:18px;font-weight:bold;text-align:center;margin:20px 0;letter-spacing:2px;">
          ${code}
        </div>
        <p style="color:#666;font-size:12px;">Thank you for maintaining premium quality standards in our B2B marketplace.</p>
      </div>`
    });
    return true;
  } catch (err) {
    console.error('Email send failed:', err);
    return false;
  }
}

// ═══════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// POST /api/register
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, role, linkedin_profile, industry, ...extra } = req.body;

    if (!email || !password || !role || !industry || !linkedin_profile)
      return res.status(400).json({ error: 'Missing required fields (email, password, role, industry, linkedin_profile)' });
    if (role !== 'employer' && role !== 'reviewer')
      return res.status(400).json({ error: 'Role must be employer or reviewer' });

    const hash = bcrypt.hashSync(password, 10);
    const cols = ['email', 'password', 'role', 'linkedin_profile', 'industry'];
    const vals = [email, hash, role, linkedin_profile, industry];

    if (role === 'employer') {
      for (const f of ['b_name', 'b_role', 'b_company', 'b_website', 'b_platform_focus', 'b_contact']) {
        cols.push(f); vals.push(extra[f] || '');
      }
    } else {
      for (const f of ['a_experience', 'a_daily_tools', 'a_country', 'a_payout_method', 'a_contact']) {
        cols.push(f); vals.push(extra[f] || '');
      }
    }

    await db.execute(
      `INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      vals
    );

    res.status(201).json({ message: 'Registration successful', role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);

    if (users.length === 0 || !bcrypt.compareSync(password, users[0].password))
      return res.status(401).json({ error: 'Invalid credentials' });

    const user = users[0];

    // Check suspended
    if (user.account_status === 'Suspended')
      return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });

    req.session.user = {
      id: user.id, email: user.email, role: user.role, industry: user.industry,
      linkedin_profile: user.linkedin_profile
    };
    res.json({ message: 'Login successful', role: user.role });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logout successful' }));
});

// GET /api/auth/user
app.get('/api/auth/user', requireAuth, (req, res) => res.json(req.session.user));


// ═══════════════════════════════════════════════
//  EMPLOYER (B-END) ROUTES
// ═══════════════════════════════════════════════

// POST /api/client/campaign — Create campaign
app.post('/api/client/campaign', requireAuth, requireRole('employer'), async (req, res) => {
  const { product_name, product_url, target_industry, target_platform, reviews_needed } = req.body;

  if (!product_name || !product_url || !target_industry || !target_platform || !reviews_needed)
    return res.status(400).json({ error: 'All fields required: product_name, product_url, target_industry, target_platform, reviews_needed' });

  if (![5, 10, 20].includes(Number(reviews_needed)))
    return res.status(400).json({ error: 'reviews_needed must be 5, 10, or 20' });

  try {
    const [result] = await db.execute(
      `INSERT INTO campaigns (employer_id, product_name, product_url, target_industry, target_platform, reviews_needed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.user.id, product_name, product_url, target_industry, target_platform, Number(reviews_needed)]
    );

    res.json({
      message: 'Campaign created. Please complete payment via the Gumroad link.',
      campaign_id: result.insertId,
      gumroad_link: `https://saastrust.gumroad.com/l/campaign-${result.insertId}`
    });
  } catch (err) {
    console.error('Campaign create error:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// POST /api/client/campaign/:id/wire-confirm — Employer confirms wire sent
app.post('/api/client/campaign/:id/wire-confirm', requireAuth, requireRole('employer'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { gumroad_email } = req.body;

  const [rows] = await db.execute('SELECT * FROM campaigns WHERE id = ? AND employer_id = ?', [id, req.session.user.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });

  await db.execute(
    `UPDATE campaigns SET status = 'Pending confirmation', gumroad_email = ? WHERE id = ?`,
    [gumroad_email || null, id]
  );
  res.json({ message: 'Confirmation sent. Admin will verify your payment shortly.' });
});

// GET /api/client/my-jobs
app.get('/api/client/my-jobs', requireAuth, requireRole('employer'), async (req, res) => {
  const [campaigns] = await db.execute(`
    SELECT c.*,
      COALESCE(SUM(CASE WHEN a.status = 'Completed' THEN 1 ELSE 0 END),0) as completed_reviews,
      (SELECT COUNT(*) FROM applications WHERE campaign_id = c.id) as total_applications
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.employer_id = ?
    GROUP BY c.id
    ORDER BY c.id DESC
  `, [req.session.user.id]);
  res.json(campaigns);
});


// ═══════════════════════════════════════════════
//  REVIEWER (A-END) ROUTES
// ═══════════════════════════════════════════════

// GET /api/tester/matched — Industry-matched active campaigns
app.get('/api/tester/matched', requireAuth, requireRole('reviewer'), async (req, res) => {
  const industry = req.session.user.industry;

  const [campaigns] = await db.execute(`
    SELECT c.*,
      c.reviews_needed - (
        SELECT COUNT(*) FROM applications WHERE campaign_id = c.id
        AND status IN ('In Progress','Under Review','Pending exchange','Completed')
      ) as remaining_slots
    FROM campaigns c
    WHERE c.target_industry = ? AND c.status = 'Active'
    HAVING remaining_slots > 0
    ORDER BY c.id DESC
  `, [industry]);

  res.json(campaigns);
});

// POST /api/tester/apply — Accept task (with capacity check)
app.post('/api/tester/apply', requireAuth, requireRole('reviewer'), async (req, res) => {
  const { campaign_id } = req.body;
  const reviewerId = req.session.user.id;

  // Capacity check
  const [countRows] = await db.execute(
    `SELECT COUNT(*) as cnt FROM applications
     WHERE campaign_id = ? AND status IN ('In Progress','Under Review','Pending exchange','Completed')`,
    [campaign_id]
  );

  const [campRows] = await db.execute('SELECT reviews_needed FROM campaigns WHERE id = ?', [campaign_id]);
  if (campRows.length === 0) return res.status(404).json({ error: 'Campaign not found' });

  if (countRows[0].cnt >= campRows[0].reviews_needed)
    return res.status(400).json({ error: 'Campaign package is fully claimed.' });

  try {
    const [result] = await db.execute(
      `INSERT INTO applications (reviewer_id, campaign_id, status) VALUES (?, ?, 'In Progress')`,
      [reviewerId, campaign_id]
    );
    res.json({ message: 'Task accepted', application_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: 'You have already claimed this campaign.' });
    console.error('Apply error:', err);
    res.status(500).json({ error: 'Failed to accept task' });
  }
});

// POST /api/tester/submit — Upload proof (In Progress → Under Review)
app.post('/api/tester/submit', requireAuth, requireRole('reviewer'), upload.single('screenshot'), async (req, res) => {
  const { application_id } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot file required' });

  const url = '/uploads/' + req.file.filename;
  const [result] = await db.execute(
    `UPDATE applications SET status = 'Under Review', screenshot_url = ? WHERE id = ? AND reviewer_id = ?`,
    [url, application_id, req.session.user.id]
  );

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Application not found' });
  res.json({ message: 'Proof submitted. Under review.' });
});

// GET /api/tester/my-applications
app.get('/api/tester/my-applications', requireAuth, requireRole('reviewer'), async (req, res) => {
  const [apps] = await db.execute(`
    SELECT a.*, c.product_name, c.target_platform, c.target_industry
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.reviewer_id = ?
    ORDER BY a.id DESC
  `, [req.session.user.id]);
  res.json(apps);
});

// GET /api/tester/balance
app.get('/api/tester/balance', requireAuth, requireRole('reviewer'), async (req, res) => {
  const [rows] = await db.execute(
    `SELECT COUNT(*) as cnt FROM applications WHERE reviewer_id = ? AND status = 'Completed'`,
    [req.session.user.id]
  );
  const count = rows[0].cnt;
  res.json({ completed_tasks: count, balance: count * 20, total_earned: count * 20 });
});


// ═══════════════════════════════════════════════
//  GUROAD WEBHOOK
// ═══════════════════════════════════════════════

// POST /api/webhook/gumroad
app.post('/api/webhook/gumroad', async (req, res) => {
  try {
    const { email, product_id, sale_id } = req.body;
    console.log('Gumroad webhook received:', { email, product_id, sale_id });

    if (email) {
      const [result] = await db.execute(
        `UPDATE campaigns SET status = 'Active'
         WHERE gumroad_email = ? AND status = 'Pending confirmation'`,
        [email]
      );
      console.log('Gumroad auto-match updated:', result.affectedRows, 'rows');
    }

    // Active verification fallback: call Gumroad API
    const accessToken = process.env.GUMROAD_ACCESS_TOKEN;
    if (accessToken && sale_id) {
      try {
        await axios.get(`https://gumroad.com/api/v2/sales/${sale_id}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
      } catch (gumErr) {
        console.warn('Gumroad active verification failed (non-fatal):', gumErr.message);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});


// ═══════════════════════════════════════════════
//  ADMIN ROUTES
// ═══════════════════════════════════════════════

// GET /admin/dashboard-data
app.get('/admin/dashboard-data', requireAuth, requireRole('admin'), async (req, res) => {
  const [rev] = await db.execute(
    `SELECT COALESCE(SUM(reviews_needed * 29.9), 0) as total_revenue FROM campaigns`
  );
  const [paidCount] = await db.execute(
    `SELECT COUNT(*) as cnt FROM applications WHERE status = 'Completed'`
  );
  const totalPayouts = paidCount[0].cnt * 20;
  const netProfit = (rev[0].total_revenue || 0) - totalPayouts;

  const [pendPay] = await db.execute(
    `SELECT COUNT(*) as cnt FROM campaigns WHERE status IN ('Pending Payments','Pending confirmation')`
  );
  const [pendProof] = await db.execute(
    `SELECT COUNT(*) as cnt FROM applications WHERE status = 'Under Review'`
  );

  res.json({
    total_revenue: Number(rev[0].total_revenue) || 0,
    net_profit: netProfit,
    pending_payments_count: pendPay[0].cnt,
    pending_proofs_count: pendProof[0].cnt
  });
});

// GET /admin/pending-payments — All campaigns except Completed
app.get('/admin/pending-payments', requireAuth, requireRole('admin'), async (req, res) => {
  const filter = req.query.filter || 'all';
  let query = `
    SELECT c.*, u.email as employer_email
    FROM campaigns c
    JOIN users u ON c.employer_id = u.id
  `;
  const params = [];

  if (filter === 'Pending Payments') {
    query += ` WHERE c.status = 'Pending Payments'`;
  } else if (filter === 'Pending confirmation') {
    query += ` WHERE c.status = 'Pending confirmation'`;
  } else if (filter === 'Active') {
    query += ` WHERE c.status = 'Active'`;
  } else if (filter === 'Completed') {
    query += ` WHERE c.status = 'Completed'`;
  }

  query += ` ORDER BY c.id DESC`;

  const [campaigns] = await db.execute(query, params);
  res.json(campaigns);
});

// POST /admin/campaigns/:id/confirm-payment — Admin confirms Gumroad payment
app.post('/admin/campaigns/:id/confirm-payment', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const [result] = await db.execute(
    `UPDATE campaigns SET status = 'Active' WHERE id = ?`,
    [id]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ message: 'Payment confirmed. Campaign is now Active.' });
});

// POST /admin/campaigns/:id/upload-invoice — Upload invoice PDF
app.post('/admin/campaigns/:id/upload-invoice', requireAuth, requireRole('admin'), invoiceUpload.single('invoice'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!req.file) return res.status(400).json({ error: 'Invoice file required' });

  const url = '/invoices/' + req.file.filename;
  await db.execute('UPDATE campaigns SET invoice_url = ? WHERE id = ?', [url, id]);
  res.json({ message: 'Invoice uploaded', invoice_url: url });
});

// POST /admin/campaigns/:id/manual-confirm — Manual override confirm
app.post('/admin/campaigns/:id/manual-confirm', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  await db.execute(`UPDATE campaigns SET status = 'Active' WHERE id = ?`, [id]);
  res.json({ message: 'Campaign manually set to Active.' });
});

// GET /admin/applications — Vetting & Disbursal
app.get('/admin/applications', requireAuth, requireRole('admin'), async (req, res) => {
  const status = req.query.status || 'Under Review';
  const [apps] = await db.execute(`
    SELECT a.*, c.product_name, c.target_platform, u.email as reviewer_email
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    JOIN users u ON a.reviewer_id = u.id
    WHERE a.status = ?
    ORDER BY a.id DESC
  `, [status]);
  res.json(apps);
});

// POST /admin/applications/:id/approve-proof — Under Review → Pending exchange
app.post('/admin/applications/:id/approve-proof', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const [result] = await db.execute(
    `UPDATE applications SET status = 'Pending exchange' WHERE id = ? AND status = 'Under Review'`,
    [id]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Application not found or not in Under Review' });
  res.json({ message: 'Proof approved. Moved to Pending exchange.' });
});

// POST /admin/applications/:id/verify-and-pay — Pending exchange → Completed (+ email + auto-complete campaign)
app.post('/admin/applications/:id/verify-and-pay', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { gift_card_code } = req.body;
  if (!gift_card_code) return res.status(400).json({ error: 'Gift card code required' });

  // Get app details
  const [apps] = await db.execute(`
    SELECT a.*, u.email as reviewer_email, c.product_name, c.id as campaign_id, c.reviews_needed
    FROM applications a
    JOIN users u ON a.reviewer_id = u.id
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.id = ? AND a.status = 'Pending exchange'
  `, [id]);

  if (apps.length === 0) return res.status(404).json({ error: 'Application not found or not in Pending exchange state' });

  const app = apps[0];

  // Update application to Completed
  await db.execute(
    `UPDATE applications SET status = 'Completed', gift_card_code = ? WHERE id = ?`,
    [gift_card_code, id]
  );

  // Auto-complete campaign if done
  const [completeCount] = await db.execute(
    `SELECT COUNT(*) as cnt FROM applications WHERE campaign_id = ? AND status = 'Completed'`,
    [app.campaign_id]
  );

  if (completeCount[0].cnt >= app.reviews_needed) {
    await db.execute(`UPDATE campaigns SET status = 'Completed' WHERE id = ?`, [app.campaign_id]);
  }

  // Send email
  await sendGiftCardEmail(app.reviewer_email, gift_card_code, app.product_name);

  res.json({ message: 'Gift card released and email sent. Campaign auto-completed if filled.', campaign_completed: completeCount[0].cnt >= app.reviews_needed });
});

// GET /admin/users
app.get('/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const search = req.query.search || '';
  let query = `SELECT * FROM users ORDER BY id DESC`;
  let params = [];
  if (search) {
    query = `SELECT * FROM users WHERE email LIKE ? ORDER BY id DESC`;
    params = [`%${search}%`];
  }
  const [users] = await db.execute(query, params);
  res.json(users);
});

// PUT /admin/users/:id
app.put('/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id);
  const { email, role, industry, linkedin_profile, account_status,
    b_name, b_role, b_company, b_website, b_platform_focus, b_contact,
    a_experience, a_daily_tools, a_country, a_payout_method, a_contact } = req.body;

  let sets = [];
  let vals = [];

  if (email !== undefined) { sets.push('email = ?'); vals.push(email); }
  if (role !== undefined) { sets.push('role = ?'); vals.push(role); }
  if (industry !== undefined) { sets.push('industry = ?'); vals.push(industry); }
  if (linkedin_profile !== undefined) { sets.push('linkedin_profile = ?'); vals.push(linkedin_profile); }
  if (account_status !== undefined) { sets.push('account_status = ?'); vals.push(account_status); }

  if (b_name !== undefined) { sets.push('b_name = ?'); vals.push(b_name); }
  if (b_role !== undefined) { sets.push('b_role = ?'); vals.push(b_role); }
  if (b_company !== undefined) { sets.push('b_company = ?'); vals.push(b_company); }
  if (b_website !== undefined) { sets.push('b_website = ?'); vals.push(b_website); }
  if (b_platform_focus !== undefined) { sets.push('b_platform_focus = ?'); vals.push(b_platform_focus); }
  if (b_contact !== undefined) { sets.push('b_contact = ?'); vals.push(b_contact); }

  if (a_experience !== undefined) { sets.push('a_experience = ?'); vals.push(a_experience); }
  if (a_daily_tools !== undefined) { sets.push('a_daily_tools = ?'); vals.push(a_daily_tools); }
  if (a_country !== undefined) { sets.push('a_country = ?'); vals.push(a_country); }
  if (a_payout_method !== undefined) { sets.push('a_payout_method = ?'); vals.push(a_payout_method); }
  if (a_contact !== undefined) { sets.push('a_contact = ?'); vals.push(a_contact); }

  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });

  vals.push(userId);
  const [result] = await db.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ message: 'User updated' });
});

// DELETE /admin/users/:id
app.delete('/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.session.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

  // Cascade: delete applications then campaigns then user
  await db.execute('DELETE FROM applications WHERE reviewer_id = ?', [userId]);
  await db.execute('DELETE FROM campaigns WHERE employer_id = ?', [userId]);
  const [result] = await db.execute('DELETE FROM users WHERE id = ?', [userId]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ message: 'User and all associated data deleted' });
});

// POST /admin/users/:id/toggle-suspend
app.post('/admin/users/:id/toggle-suspend', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id);
  const [rows] = await db.execute('SELECT account_status FROM users WHERE id = ?', [userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

  const newStatus = rows[0].account_status === 'Suspended' ? 'Approved' : 'Suspended';
  await db.execute('UPDATE users SET account_status = ? WHERE id = ?', [newStatus, userId]);
  res.json({ message: `User ${newStatus === 'Suspended' ? 'suspended' : 'approved'}`, account_status: newStatus });
});


// ═══════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`SaaSTrust.net v3.1 running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
