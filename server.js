require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const axios = require('axios');

const db = require('./db');
const MySQLStore = require('express-mysql-session')(session);
const emailService = require('./services/emailService');

const app = express();
const PORT = process.env.PORT || 3000;

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

    // Normalize old status values to v3.1 format
    try {
      const [r1] = await db.execute(`UPDATE campaigns SET status = 'Pending Payments' WHERE status IN ('pending_payment', 'Pending', 'pending')`);
      const [r2] = await db.execute(`UPDATE campaigns SET status = 'Pending confirmation' WHERE status IN ('pending_confirmation', 'Pending Wait', 'pending_wait')`);
      if (r1.affectedRows + r2.affectedRows > 0)
        console.log(`  Migrated ${r1.affectedRows + r2.affectedRows} campaign statuses to v3.1 format`);
    } catch (e) { console.log('  Status migration note:', e.message); }

    // applications: new v3.1 columns
    await safeAlter(`ALTER TABLE applications ADD COLUMN gift_card_code VARCHAR(255) DEFAULT NULL`);
    // unique key
    await safeAlter(`ALTER TABLE applications ADD UNIQUE KEY unique_match (reviewer_id, campaign_id)`);

    // system_configs key-value table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS system_configs (
        \`key\` VARCHAR(255) PRIMARY KEY,
        \`value\` TEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // gumroad_orders — synced sales from Gumroad API
    await db.execute(`
      CREATE TABLE IF NOT EXISTS gumroad_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        gumroad_sale_id VARCHAR(255) UNIQUE NOT NULL,
        buyer_email VARCHAR(255) NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        amount DECIMAL(10,2) DEFAULT 0,
        currency VARCHAR(10) DEFAULT 'USD',
        purchase_date DATETIME,
        campaign_id INT DEFAULT NULL,
        sync_status VARCHAR(50) DEFAULT 'synced',
        raw_data JSON DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

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
  key: 'saas_trust_sid',
  secret: process.env.SESSION_SECRET || '!SaasTrustNet123_Session_Secret',
  store: new MySQLStore({
    clearExpired: true,
    checkExpirationInterval: 900000,   // 15 mins
    expiration: 86400000,              // 1 day
    createDatabaseTable: true          // auto-create sessions table
  }, db.pool),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 86400000
  }
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

// ═══════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Public API: Get current user (returns { user } or { user: null }) ──
app.get('/api/me', (req, res) => {
  if (req.session.user) {
    res.json({ user: req.session.user });
  } else {
    res.json({ user: null });
  }
});

// ── Settings API (employer + reviewer) ──
// GET /api/user/settings — fetch current user's settings (role-specific)
app.get('/api/user/settings', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const [rows] = await db.execute(
    'SELECT email, role, company_name, contact_name, gumroad_email, payout_email, linkedin_url, industry, account_balance, total_payouts FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });

  const u = rows[0];
  res.json({
    email: u.email,
    role: u.role,
    // employer fields
    company_name: u.company_name || '',
    contact_name: u.contact_name || '',
    gumroad_email: u.gumroad_email || '',
    // reviewer fields
    payout_email: u.payout_email || '',
    linkedin_url: u.linkedin_url || '',
    industry: u.industry || '',
    account_balance: Number(u.account_balance) || 0,
    total_payouts: Number(u.total_payouts) || 0
  });
});

// PUT /api/user/settings — update allowed fields (session-locked to self)
app.put('/api/user/settings', requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const role = req.session.user.role;

  if (role === 'employer') {
    const { company_name, contact_name } = req.body;
    if (company_name === undefined && contact_name === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    const sets = [], params = [];
    if (company_name !== undefined) { sets.push('company_name = ?'); params.push(company_name); }
    if (contact_name !== undefined) { sets.push('contact_name = ?'); params.push(contact_name); }
    params.push(userId);
    await db.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

    // Refresh session
    if (company_name !== undefined) req.session.user.company_name = company_name;
    if (contact_name !== undefined) req.session.user.contact_name = contact_name;
    return res.json({ ok: true });
  }

  if (role === 'reviewer') {
    const { payout_email } = req.body;
    if (payout_email === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await db.execute('UPDATE users SET payout_email = ? WHERE id = ?', [payout_email, userId]);

    req.session.user.payout_email = payout_email;
    return res.json({ ok: true });
  }

  return res.status(403).json({ error: 'Forbidden role' });
});

// ── Public API: Pack URLs for pricing section ──
app.get('/api/public/pack-urls', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT `key`, `value` FROM system_configs WHERE `key` IN (?, ?, ?)',
      ['gumroad_pack1_url', 'gumroad_pack2_url', 'gumroad_pack3_url']
    );
    const configs = {};
    rows.forEach(r => { configs[r.key] = r.value; });
    res.json({
      pack1: configs['gumroad_pack1_url'] || '#',
      pack2: configs['gumroad_pack2_url'] || '#',
      pack3: configs['gumroad_pack3_url'] || '#',
    });
  } catch (err) {
    console.error('GET /api/public/pack-urls error:', err);
    res.json({ pack1: '#', pack2: '#', pack3: '#' });
  }
});

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

    // ── Trigger 1: Employer Welcome Email (non-blocking) ──
    if (role === 'employer') {
      const name = extra?.b_name || email.split('@')[0];
      emailService.sendEmployerWelcome(email, name).catch(() => {});
    }

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
      `INSERT INTO campaigns (employer_id, product_name, product_url, target_industry, target_platform, reviews_needed, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Pending Payments')`,
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

// POST /api/employer/campaigns/:id/submit-payment — Employer submits payment email
app.post('/api/employer/campaigns/:id/submit-payment', requireAuth, requireRole('employer'), async (req, res) => {
  const campaignId = parseInt(req.params.id);
  const employerId = req.session.user.id;
  const { gumroad_email } = req.body;

  if (!gumroad_email || !gumroad_email.includes('@'))
    return res.status(400).json({ error: 'Valid gumroad_email is required' });

  try {
    const [campRows] = await db.execute('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (campRows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    if (campRows[0].employer_id !== employerId) return res.status(403).json({ error: 'Not your campaign' });
    if (campRows[0].status !== 'Pending Payments')
      return res.status(400).json({ error: 'Campaign is not in Pending Payments status. Current: ' + campRows[0].status });

    await db.execute(
      'UPDATE campaigns SET gumroad_email = ?, status = ? WHERE id = ?',
      [gumroad_email.trim(), 'Pending confirmation', campaignId]
    );

    // ── Trigger 2: Payment Pending Email (non-blocking) ──
    const campaignTitle = campRows[0].product_name || `Campaign #${campaignId}`;
    emailService.sendPaymentPending(req.session.user.email, campaignTitle, gumroad_email.trim()).catch(() => {});

    res.json({ message: 'Payment submitted for review', status: 'Pending confirmation' });
  } catch (err) {
    console.error('submit-payment error:', err);
    res.status(500).json({ error: 'Failed to submit payment' });
  }
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

  // Dynamically compute reward_amount from parent campaign reviews_needed
  const campaignsWithPrice = campaigns.map(c => ({
    ...c,
    reward_amount: c.reviews_needed >= 20 ? 20 : 15
  }));
  res.json(campaignsWithPrice);
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
    // ── Trigger 3: Reviewer Task Locked Email (non-blocking) ──
    const reviewerEmail = req.session.user.email;
    const campaignTitle = campRows[0]?.product_name || `Campaign #${campaign_id}`;
    emailService.sendReviewerTaskLocked(reviewerEmail, campaignTitle).catch(() => {});

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

  // ── Trigger 4: Notify Employer (non-blocking) ──
  try {
    const [rows] = await db.execute(`
      SELECT c.product_name, u.email as employer_email
      FROM applications a
      JOIN campaigns c ON a.campaign_id = c.id
      JOIN users u ON c.employer_id = u.id
      WHERE a.id = ?
    `, [application_id]);
    if (rows.length > 0) {
      emailService.sendEmployerReviewSubmitted(rows[0].employer_email, rows[0].product_name).catch(() => {});
    }
  } catch (e) { console.error('[Email] Trigger 4 failed (non-fatal):', e.message); }

  res.json({ message: 'Proof submitted. Under review.' });
});

// GET /api/tester/my-applications
app.get('/api/tester/my-applications', requireAuth, requireRole('reviewer'), async (req, res) => {
  const [apps] = await db.execute(`
    SELECT a.*, c.product_name, c.target_platform, c.target_industry, c.reviews_needed
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.reviewer_id = ?
    ORDER BY a.id DESC
  `, [req.session.user.id]);
  // Dynamically attach reward_amount
  const appsWithPrice = apps.map(a => ({
    ...a,
    reward_amount: a.reviews_needed >= 20 ? 20 : 15
  }));
  res.json(appsWithPrice);
});

// GET /api/tester/balance
app.get('/api/tester/balance', requireAuth, requireRole('reviewer'), async (req, res) => {
  const [rows] = await db.execute(
    `SELECT COUNT(*) as cnt,
      COALESCE(SUM(
        CASE WHEN c.reviews_needed >= 20 THEN 20 ELSE 15 END
      ), 0) as total_earned
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.reviewer_id = ? AND a.status = 'Completed'`,
    [req.session.user.id]
  );
  const count = rows[0].cnt;
  const totalEarned = Number(rows[0].total_earned) || 0;
  res.json({ completed_tasks: count, balance: totalEarned, total_earned: totalEarned });
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
    `SELECT COUNT(*) as cnt,
      COALESCE(SUM(
        CASE WHEN c.reviews_needed >= 20 THEN 20 ELSE 15 END
      ), 0) as total_payouts
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.status = 'Completed'`
  );
  const totalPayouts = Number(paidCount[0].total_payouts) || 0;
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

// GET /admin/pending-payments — All campaigns except Completed (with optional cascaded applications)
app.get('/admin/pending-payments', requireAuth, requireRole('admin'), async (req, res) => {
  const filter = req.query.filter || 'all';
  const includeApps = req.query.include_apps === '1';
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

  // Cascade: fetch applications for all campaigns in one go
  if (includeApps && campaigns.length > 0) {
    const campaignIds = campaigns.map(c => c.id);
    const placeholders = campaignIds.map(() => '?').join(',');
    const [apps] = await db.execute(`
      SELECT a.*, u.email as reviewer_email, u.linkedin_profile
      FROM applications a
      JOIN users u ON a.reviewer_id = u.id
      WHERE a.campaign_id IN (${placeholders})
      ORDER BY a.id ASC
    `, campaignIds);

    // Group by campaign_id
    const appMap = {};
    apps.forEach(a => {
      if (!appMap[a.campaign_id]) appMap[a.campaign_id] = [];
      appMap[a.campaign_id].push(a);
    });
    campaigns.forEach(c => {
      c.applications = appMap[c.id] || [];
    });
  }

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
  try {
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

    // Send email (non-blocking)
    emailService.sendReviewerPayout(app.reviewer_email, gift_card_code, app.product_name).catch(() => {});

    res.json({ message: 'Gift card released and email sent. Campaign auto-completed if filled.', campaign_completed: completeCount[0].cnt >= app.reviews_needed });
  } catch (err) {
    console.error('POST /admin/applications/:id/verify-and-pay error:', err);
    res.status(500).json({ error: 'Server error while releasing payment' });
  }
});

// GET /admin/campaigns/:id/applications — Get all applications for a campaign
app.get('/admin/campaigns/:id/applications', requireAuth, requireRole('admin'), async (req, res) => {
  const campaignId = parseInt(req.params.id);
  try {
    const [apps] = await db.execute(`
      SELECT a.*, u.email as reviewer_email, u.linkedin_profile, u.linkedin_id
      FROM applications a
      JOIN users u ON a.reviewer_id = u.id
      WHERE a.campaign_id = ?
      ORDER BY a.id ASC
    `, [campaignId]);
    res.json(apps);
  } catch (err) {
    console.error('GET /admin/campaigns/:id/applications error:', err);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

// POST /admin/applications/:id/reject — Under Review → Rejected
app.post('/admin/applications/:id/reject', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [result] = await db.execute(
      `UPDATE applications SET status = 'Rejected', screenshot_url = NULL WHERE id = ? AND status = 'Under Review'`,
      [id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Application not found or not in Under Review' });
    res.json({ message: 'Application rejected.' });
  } catch (err) {
    console.error('Reject error:', err);
    res.status(500).json({ error: 'Failed to reject application' });
  }
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

// GET /admin/configs — Fetch all system configs
app.get('/admin/configs', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT `key`, `value` FROM system_configs');
    const configs = {};
    rows.forEach(r => { configs[r.key] = r.value; });
    res.json(configs);
  } catch (err) {
    console.error('GET /admin/configs error:', err);
    res.status(500).json({ error: 'Failed to load configs' });
  }
});

// POST /admin/configs — Save system configs (generic upsert)
app.post('/admin/configs', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      if (key === 'gumroad_webhook') continue; // read-only
      await db.execute(
        `INSERT INTO system_configs (\`key\`, \`value\`) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`,
        [key, value != null ? String(value) : '']
      );
    }
    res.json({ message: 'Configuration saved' });
  } catch (err) {
    console.error('POST /admin/configs error:', err);
    res.status(500).json({ error: 'Failed to save configs' });
  }
});

// GET /api/admin/gumroad/orders — Load synced orders from database
app.get('/api/admin/gumroad/orders', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT go.*, c.product_name as campaign_product_name, c.status as campaign_status
       FROM gumroad_orders go
       LEFT JOIN campaigns c ON go.campaign_id = c.id
       ORDER BY go.purchase_date DESC
       LIMIT 100`
    );
    const orders = rows.map(o => ({
      id: o.id,
      gumroad_sale_id: o.gumroad_sale_id,
      buyer_email: o.buyer_email,
      product_name: o.product_name,
      amount: Number(o.amount),
      currency: o.currency,
      purchase_date: o.purchase_date,
      campaign_id: o.campaign_id,
      campaign_product_name: o.campaign_product_name || null,
      campaign_status: o.campaign_status || null,
      sync_status: o.sync_status,
      created_at: o.created_at
    }));
    res.json({ orders });
  } catch (err) {
    console.error('[Gumroad Orders] GET error:', err);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// POST /api/admin/gumroad/sync — Sync orders from Gumroad API
app.post('/api/admin/gumroad/sync', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    // 1. Read Gumroad Access Token from system_configs
    const [tokenRows] = await db.execute(
      'SELECT `value` FROM system_configs WHERE `key` = ?', ['gumroad_access_token']
    );
    if (!tokenRows.length || !tokenRows[0].value) {
      return res.status(400).json({ error: 'Gumroad Access Token not configured. Please set it in Panel 0 · Config first.' });
    }
    const accessToken = tokenRows[0].value;

    // 2. Fetch sales from Gumroad API
    console.log('[Gumroad Sync] Fetching sales from Gumroad API...');
    let gumroadRes;
    try {
      gumroadRes = await axios.get('https://api.gumroad.com/v2/sales', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    } catch (apiErr) {
      console.error('[Gumroad Sync] API call failed:', apiErr.message);
      return res.status(502).json({ error: 'Gumroad API request failed: ' + apiErr.message });
    }

    const sales = gumroadRes.data?.sales || [];
    console.log(`[Gumroad Sync] Received ${sales.length} sales from Gumroad`);

    if (sales.length === 0) {
      return res.json({ message: 'No sales found in Gumroad account.', orders: [], synced: 0, activated: 0 });
    }

    let syncedCount = 0;
    let activatedCount = 0;

    // 3. Process each sale
    for (const sale of sales) {
      const saleId = sale.id;
      const buyerEmail = sale.email || '';
      const productName = sale.product_name || sale.name || 'Unknown Product';
      const amount = parseFloat(sale.price) || 0;
      const currency = sale.currency || 'USD';
      const purchaseDate = sale.created_at ? new Date(sale.created_at) : new Date();

      if (!saleId || !buyerEmail) {
        console.log('[Gumroad Sync] Skipping sale (missing id or email):', saleId);
        continue;
      }

      // 3a. Check if order already exists
      const [existRows] = await db.execute(
        'SELECT id, campaign_id FROM gumroad_orders WHERE gumroad_sale_id = ?',
        [String(saleId)]
      );

      if (existRows.length === 0) {
        // 3b. INSERT new record
        await db.execute(
          `INSERT INTO gumroad_orders (gumroad_sale_id, buyer_email, product_name, amount, currency, purchase_date, raw_data)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [String(saleId), buyerEmail, productName, amount, currency, purchaseDate, JSON.stringify(sale)]
        );
        syncedCount++;

        // 3c. Try to match campaign by buyer_email → gumroad_email and auto-activate
        const [campRows] = await db.execute(
          `SELECT id FROM campaigns WHERE gumroad_email = ? AND status = 'Pending Payments'`,
          [buyerEmail]
        );

        if (campRows.length > 0) {
          const campaignId = campRows[0].id;
          await db.execute(
            `UPDATE campaigns SET status = 'Active' WHERE id = ?`,
            [campaignId]
          );
          // Link the order to the campaign
          await db.execute(
            `UPDATE gumroad_orders SET campaign_id = ? WHERE gumroad_sale_id = ?`,
            [campaignId, String(saleId)]
          );
          activatedCount++;
          console.log(`[Gumroad Sync] Campaign #${campaignId} auto-activated (matched: ${buyerEmail})`);
        }
      } else {
        // 3d. Already exists — try re-match if not yet linked and product matches
        const existingCampaignId = existRows[0].campaign_id;
        if (!existingCampaignId) {
          const [campRows] = await db.execute(
            `SELECT id FROM campaigns WHERE gumroad_email = ? AND status = 'Pending Payments'`,
            [buyerEmail]
          );
          if (campRows.length > 0) {
            const campaignId = campRows[0].id;
            await db.execute(
              `UPDATE campaigns SET status = 'Active' WHERE id = ?`,
              [campaignId]
            );
            await db.execute(
              `UPDATE gumroad_orders SET campaign_id = ? WHERE gumroad_sale_id = ?`,
              [campaignId, String(saleId)]
            );
            activatedCount++;
            console.log(`[Gumroad Sync] Campaign #${campaignId} auto-activated (retry match: ${buyerEmail})`);
          }
        }
      }
    }

    // 4. Return latest orders for frontend table
    const [latestOrders] = await db.execute(
      `SELECT go.*, c.product_name as campaign_product_name, c.status as campaign_status
       FROM gumroad_orders go
       LEFT JOIN campaigns c ON go.campaign_id = c.id
       ORDER BY go.purchase_date DESC
       LIMIT 100`
    );

    // Format for frontend
    const orders = latestOrders.map(o => ({
      id: o.id,
      gumroad_sale_id: o.gumroad_sale_id,
      buyer_email: o.buyer_email,
      product_name: o.product_name,
      amount: Number(o.amount),
      currency: o.currency,
      purchase_date: o.purchase_date,
      campaign_id: o.campaign_id,
      campaign_product_name: o.campaign_product_name || null,
      campaign_status: o.campaign_status || null,
      sync_status: o.sync_status,
      created_at: o.created_at
    }));

    res.json({
      message: `Sync complete: ${syncedCount} new order(s) imported, ${activatedCount} campaign(s) auto-activated.`,
      orders,
      synced: syncedCount,
      activated: activatedCount
    });

  } catch (err) {
    console.error('[Gumroad Sync] Unexpected error:', err);
    res.status(500).json({ error: 'Gumroad sync failed: ' + err.message });
  }
});

// GET /api/employer/campaigns/:id/invoice — Employer downloads invoice for own campaign
app.get('/api/employer/campaigns/:id/invoice', requireAuth, requireRole('employer'), async (req, res) => {
  const campaignId = parseInt(req.params.id);
  const employerId = req.session.user.id;

  try {
    const [rows] = await db.execute(
      'SELECT invoice_url FROM campaigns WHERE id = ? AND employer_id = ?',
      [campaignId, employerId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    if (!rows[0].invoice_url) return res.status(404).json({ error: 'No invoice uploaded yet' });

    const filePath = path.join(__dirname, 'public', rows[0].invoice_url);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Invoice file not found on server' });

    res.sendFile(filePath);
  } catch (err) {
    console.error('Invoice download error:', err);
    res.status(500).json({ error: 'Failed to download invoice' });
  }
});

// GET /api/employer/pack-urls — Get pack URLs for employer frontend
app.get('/api/employer/pack-urls', requireAuth, requireRole('employer'), async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT `key`, `value` FROM system_configs WHERE `key` IN (?, ?, ?)',
      ['gumroad_pack1_url', 'gumroad_pack2_url', 'gumroad_pack3_url']
    );
    const configs = {};
    rows.forEach(r => { configs[r.key] = r.value; });
    res.json({
      gumroad_pack1_url: configs['gumroad_pack1_url'] || '',
      gumroad_pack2_url: configs['gumroad_pack2_url'] || '',
      gumroad_pack3_url: configs['gumroad_pack3_url'] || ''
    });
  } catch (err) {
    console.error('GET /api/employer/pack-urls error:', err);
    res.status(500).json({ error: 'Failed to load pack urls' });
  }
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
