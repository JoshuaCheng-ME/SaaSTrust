const express = require('express');
const session = require('express-session');
const sqlite3 = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接
const db = sqlite3('./saastrust.db');

// 初始化数据库表
function initDB() {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      linkedin_url TEXT,
      industry VARCHAR(100) NOT NULL
    )
  `);
  
  // Campaigns table
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      product_name VARCHAR(255) NOT NULL,
      target_site VARCHAR(50) NOT NULL,
      req_industry VARCHAR(100) NOT NULL,
      total_slots INTEGER NOT NULL,
      status VARCHAR(50) DEFAULT 'pending_payment',
      FOREIGN KEY (client_id) REFERENCES users(id)
    )
  `);
  
  // Applications table
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      tester_id INTEGER NOT NULL,
      status VARCHAR(50) DEFAULT 'assigned',
      proof_url TEXT,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (tester_id) REFERENCES users(id)
    )
  `);
  
  // Create admin user if not exists
  const adminCheck = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@saastrust.net');
  if (!adminCheck) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (email, password, role, industry) VALUES (?, ?, ?, ?)')
      .run('admin@saastrust.net', hashedPassword, 'admin', 'Admin');
    console.log('Admin user created: admin@saastrust.net / admin123');
  }
}

initDB();

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'saastrust-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// 认证中间件
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login.html');
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
  };
}

// API Routes

// 注册
app.post('/api/auth/register', (req, res) => {
  const { email, password, role, industry, linkedin_url } = req.body;
  
  if (!email || !password || !role || !industry) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const hashedPassword = bcrypt.hashSync(password, 10);
    const stmt = db.prepare(`
      INSERT INTO users (email, password, role, industry, linkedin_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(email, hashedPassword, role, industry, linkedin_url || null);
    res.status(201).json({ message: 'Registration successful', role });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      res.status(400).json({ error: 'Email already exists' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

// 登录
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  req.session.user = {
    id: user.id,
    email: user.email,
    role: user.role,
    industry: user.industry
  };
  
  res.json({ message: 'Login successful', role: user.role });
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logout successful' });
});

// 获取当前用户
app.get('/api/auth/user', requireAuth, (req, res) => {
  res.json(req.session.user);
});

// B端创建活动
app.post('/api/client/campaign', requireAuth, requireRole('client'), (req, res) => {
  const { product_name, target_site, req_industry, total_slots } = req.body;
  
  if (!product_name || !target_site || !req_industry || !total_slots) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const stmt = db.prepare(`
    INSERT INTO campaigns (client_id, product_name, target_site, req_industry, total_slots)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(req.session.user.id, product_name, target_site, req_industry, total_slots);
  
  res.json({ message: 'Campaign created successfully', status: 'pending_payment' });
});

// B端查看我的任务
app.get('/api/client/my-jobs', requireAuth, requireRole('client'), (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, 
           COUNT(a.id) as completed_count,
           (SELECT COUNT(*) FROM applications WHERE campaign_id = c.id AND status = 'approved') as approved_count
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.client_id = ?
    GROUP BY c.id
    ORDER BY c.id DESC
  `).all(req.session.user.id);
  
  res.json(campaigns);
});

// A端智能匹配任务
app.get('/api/tester/matched', requireAuth, requireRole('tester'), (req, res) => {
  const testerIndustry = req.session.user.industry;
  
  const matchedCampaigns = db.prepare(`
    SELECT c.*,
           (c.total_slots - COUNT(a.id)) as remaining_slots
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.req_industry = ? AND c.status = 'active'
    GROUP BY c.id
    HAVING remaining_slots > 0
    ORDER BY c.id DESC
  `).all(testerIndustry);
  
  res.json(matchedCampaigns);
});

// A端接单
app.post('/api/tester/apply', requireAuth, requireRole('tester'), (req, res) => {
  const { campaign_id } = req.body;
  
  // 检查是否已接过此任务
  const existing = db.prepare(`
    SELECT id FROM applications WHERE campaign_id = ? AND tester_id = ?
  `).get(campaign_id, req.session.user.id);
  
  if (existing) {
    return res.status(400).json({ error: 'You have already applied for this campaign' });
  }
  
  const stmt = db.prepare(`
    INSERT INTO applications (campaign_id, tester_id, status)
    VALUES (?, ?, 'assigned')
  `);
  stmt.run(campaign_id, req.session.user.id);
  
  res.json({ message: 'Application submitted successfully' });
});

// A端提交任务
app.post('/api/tester/submit', requireAuth, requireRole('tester'), (req, res) => {
  const { application_id, proof_url } = req.body;
  
  const stmt = db.prepare(`
    UPDATE applications SET status = 'submitted', proof_url = ? WHERE id = ? AND tester_id = ?
  `);
  const result = stmt.run(proof_url, application_id, req.session.user.id);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Application not found or not authorized' });
  }
  
  res.json({ message: 'Proof submitted successfully, waiting for review' });
});

// A端查看我的工单
app.get('/api/tester/my-applications', requireAuth, requireRole('tester'), (req, res) => {
  const applications = db.prepare(`
    SELECT a.*, c.product_name, c.target_site, c.req_industry
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.tester_id = ?
    ORDER BY a.id DESC
  `).all(req.session.user.id);
  
  res.json(applications);
});

// 管理员查看待审核列表
app.get('/api/admin/pending', requireAuth, requireRole('admin'), (req, res) => {
  const pending = db.prepare(`
    SELECT a.*, c.product_name, c.target_site, u.email as tester_email
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    JOIN users u ON a.tester_id = u.id
    WHERE a.status = 'submitted'
    ORDER BY a.id DESC
  `).all();
  
  res.json(pending);
});

// 管理员审核通过
app.post('/api/admin/approve', requireAuth, requireRole('admin'), (req, res) => {
  const { application_id } = req.body;
  
  const stmt = db.prepare(`
    UPDATE applications SET status = 'approved' WHERE id = ?
  `);
  const result = stmt.run(application_id);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Application not found' });
  }
  
  res.json({ message: 'Application approved successfully' });
});

// 获取账户余额（简化版）
app.get('/api/tester/balance', requireAuth, requireRole('tester'), (req, res) => {
  const approvedCount = db.prepare(`
    SELECT COUNT(*) as count FROM applications WHERE tester_id = ? AND status = 'approved'
  `).get(req.session.user.id).count;
  
  // 假设每条审核通过得 $20
  const balance = approvedCount * 20;
  
  res.json({ balance });
});

// 首页路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
