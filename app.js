const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接
const db = new sqlite3.Database('./saastrust.db');

// 初始化数据库表
function initDB() {
  // Users table
  db.run(`
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
  db.run(`
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
  db.run(`
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
  db.get('SELECT id FROM users WHERE email = ?', ['admin@saastrust.net'], (err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run('INSERT INTO users (email, password, role, industry) VALUES (?, ?, ?, ?)',
        ['admin@saastrust.net', hashedPassword, 'admin', 'Admin'], (err) => {
          if (!err) {
            console.log('Admin user created: admin@saastrust.net / admin123');
          }
        });
    }
  });
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
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  db.run(`INSERT INTO users (email, password, role, industry, linkedin_url) VALUES (?, ?, ?, ?, ?)`,
    [email, hashedPassword, role, industry, linkedin_url || null], (err) => {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Email already exists' });
        }
        return res.status(500).json({ error: 'Registration failed' });
      }
      res.status(201).json({ message: 'Registration successful', role });
    });
});

// 登录
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
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
  
  db.run(`INSERT INTO campaigns (client_id, product_name, target_site, req_industry, total_slots) VALUES (?, ?, ?, ?, ?)`,
    [req.session.user.id, product_name, target_site, req_industry, total_slots], (err) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to create campaign' });
      }
      res.json({ message: 'Campaign created successfully', status: 'pending_payment' });
    });
});

// B端查看我的任务
app.get('/api/client/my-jobs', requireAuth, requireRole('client'), (req, res) => {
  db.all(`
    SELECT c.*, 
           COUNT(a.id) as completed_count,
           SUM(CASE WHEN a.status = 'approved' THEN 1 ELSE 0 END) as approved_count
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.client_id = ?
    GROUP BY c.id
    ORDER BY c.id DESC
  `, [req.session.user.id], (err, campaigns) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }
    res.json(campaigns);
  });
});

// A端智能匹配任务
app.get('/api/tester/matched', requireAuth, requireRole('tester'), (req, res) => {
  const testerIndustry = req.session.user.industry;
  
  db.all(`
    SELECT c.*,
           (c.total_slots - COUNT(a.id)) as remaining_slots
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.req_industry = ? AND c.status = 'active'
    GROUP BY c.id
    HAVING remaining_slots > 0
    ORDER BY c.id DESC
  `, [testerIndustry], (err, matchedCampaigns) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch matched jobs' });
    }
    res.json(matchedCampaigns);
  });
});

// A端接单
app.post('/api/tester/apply', requireAuth, requireRole('tester'), (req, res) => {
  const { campaign_id } = req.body;
  
  // 检查是否已接过此任务
  db.get(`SELECT id FROM applications WHERE campaign_id = ? AND tester_id = ?`,
    [campaign_id, req.session.user.id], (err, row) => {
      if (row) {
        return res.status(400).json({ error: 'You have already applied for this campaign' });
      }
      
      db.run(`INSERT INTO applications (campaign_id, tester_id, status) VALUES (?, ?, 'assigned')`,
        [campaign_id, req.session.user.id], (err) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to apply' });
          }
          res.json({ message: 'Application submitted successfully' });
        });
    });
});

// A端提交任务
app.post('/api/tester/submit', requireAuth, requireRole('tester'), (req, res) => {
  const { application_id, proof_url } = req.body;
  
  db.run(`UPDATE applications SET status = 'submitted', proof_url = ? WHERE id = ? AND tester_id = ?`,
    [proof_url, application_id, req.session.user.id], function(err) {
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Application not found or not authorized' });
      }
      res.json({ message: 'Proof submitted successfully, waiting for review' });
    });
});

// A端查看我的工单
app.get('/api/tester/my-applications', requireAuth, requireRole('tester'), (req, res) => {
  db.all(`
    SELECT a.*, c.product_name, c.target_site, c.req_industry
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.tester_id = ?
    ORDER BY a.id DESC
  `, [req.session.user.id], (err, applications) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch applications' });
    }
    res.json(applications);
  });
});

// 管理员查看待审核列表
app.get('/api/admin/pending', requireAuth, requireRole('admin'), (req, res) => {
  db.all(`
    SELECT a.*, c.product_name, c.target_site, u.email as tester_email
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    JOIN users u ON a.tester_id = u.id
    WHERE a.status = 'submitted'
    ORDER BY a.id DESC
  `, (err, pending) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch pending' });
    }
    res.json(pending);
  });
});

// 管理员审核通过
app.post('/api/admin/approve', requireAuth, requireRole('admin'), (req, res) => {
  const { application_id } = req.body;
  
  db.run(`UPDATE applications SET status = 'approved' WHERE id = ?`, [application_id], function(err) {
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }
    res.json({ message: 'Application approved successfully' });
  });
});

// 获取账户余额
app.get('/api/tester/balance', requireAuth, requireRole('tester'), (req, res) => {
  db.get(`SELECT COUNT(*) as count FROM applications WHERE tester_id = ? AND status = 'approved'`,
    [req.session.user.id], (err, result) => {
      const approvedCount = result.count;
      const balance = approvedCount * 20;
      res.json({ balance });
    });
});

// 首页路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
