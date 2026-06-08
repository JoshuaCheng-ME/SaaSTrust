// Load environment variables
require('dotenv').config();

const mysql = require('mysql2');

// MySQL 连接池配置
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'u442193569_user',
    password: process.env.DB_PASSWORD || '!SaasTrustNet123',
    database: process.env.DB_NAME || 'u442193569_saastrustnet',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+00:00'
});

module.exports = pool.promise();