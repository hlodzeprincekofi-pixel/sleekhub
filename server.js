const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const db = new sqlite3.Database('./database.sqlite');

// 1. Folders
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// 2. Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'sleek-master-key-777',
    resave: true,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// 3. Database Initialization
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, email TEXT, bio TEXT, profile_pic TEXT DEFAULT 'default-avatar.png', last_active DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, content TEXT, image TEXT, likes INTEGER DEFAULT 0, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS likes (user_id INTEGER, post_id INTEGER, UNIQUE(user_id, post_id))");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER, receiver_id INTEGER, content TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
    db.run("CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, from_user TEXT, type TEXT, is_read INTEGER DEFAULT 0, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
});

// Update activity
app.use((req, res, next) => {
    if (req.session.userId) db.run("UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?", [req.session.userId]);
    next();
});

// --- AUTH ROUTES ---
app.post('/signup', upload.single('profile_pic'), (req, res) => {
    const { username, password, email, bio } = req.body;
    const pic = req.file ? req.file.filename : 'default-avatar.png';
    db.run("INSERT INTO users (username, password, email, bio, profile_pic) VALUES (?, ?, ?, ?, ?)", [username, bcrypt.hashSync(password, 10), email, bio, pic], (err) => {
        if (err) return res.status(400).json({ error: "Username taken" });
        res.json({ message: "OK" });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err || !user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: "Fail" });
        req.session.userId = user.id;
        req.session.username = user.username;
        res.json({ message: "OK" });
    });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    db.get("SELECT id, username, email, bio, profile_pic FROM users WHERE id = ?", [req.session.userId], (err, user) => {
        res.json({ loggedIn: true, ...user });
    });
});

// --- PROFILE & BIO FIXES ---
app.post('/api/update-profile', upload.single('profile_pic'), (req, res) => {
    if (!req.session.userId) return res.status(401).send();
    const { bio } = req.body;
    if (req.file) {
        db.run("UPDATE users SET bio = ?, profile_pic = ? WHERE id = ?", [bio, req.file.filename, req.session.userId], () => res.json({ message: "OK" }));
    } else {
        db.run("UPDATE users SET bio = ? WHERE id = ?", [bio, req.session.userId], () => res.json({ message: "OK" }));
    }
});

app.get('/api/user-profile/:username', (req, res) => {
    db.get("SELECT id, username, email, bio, profile_pic FROM users WHERE username = ?", [req.params.username], (err, row) => res.json(row || {}));
});

// --- REMAINING ROUTES (Unchanged) ---
app.get('/api/posts', (req, res) => {
    const uid = req.session.userId || 0;
    db.all(`SELECT p.*, strftime('%Y-%m-%dT%H:%M:%SZ', p.timestamp) as timestamp, (SELECT 1 FROM likes WHERE post_id = p.id AND user_id = ?) as has_liked FROM posts p ORDER BY id DESC LIMIT 50`, [uid], (err, rows) => res.json(rows || []));
});
app.post('/api/posts', upload.single('post_image'), (req, res) => {
    db.run("INSERT INTO posts (username, content, image) VALUES (?, ?, ?)", [req.session.username, req.body.content, req.file ? req.file.filename : null], () => res.json({ message: "OK" }));
});
app.get('/api/users', (req, res) => {
    db.all("SELECT id, username, profile_pic, (strftime('%s', 'now') - strftime('%s', last_active)) as seconds_ago FROM users", [], (err, rows) => res.json(rows || []));
});
app.get('/api/search', (req, res) => {
    db.all("SELECT username, profile_pic FROM users WHERE username LIKE ? LIMIT 5", [`%${req.query.q}%`], (err, rows) => res.json(rows || []));
});
app.post('/api/posts/:id/like', (req, res) => {
    const pid = req.params.id; const uid = req.session.userId;
    db.get("SELECT (SELECT id FROM users WHERE username = posts.username) as owner_id FROM posts WHERE id = ?", [pid], (err, post) => {
        db.run("INSERT INTO likes (user_id, post_id) VALUES (?, ?)", [uid, pid], function(err) {
            if (err) {
                db.run("DELETE FROM likes WHERE user_id = ? AND post_id = ?", [uid, pid], () => {
                    db.run("UPDATE posts SET likes = likes - 1 WHERE id = ?", [pid], () => res.json({ liked: false }));
                });
            } else {
                db.run("UPDATE posts SET likes = likes + 1 WHERE id = ?", [pid], () => {
                    if (post && post.owner_id !== uid) db.run("INSERT INTO notifications (user_id, from_user, type) VALUES (?, ?, ?)", [post.owner_id, req.session.username, 'liked your post']);
                    res.json({ liked: true });
                });
            }
        });
    });
});
app.get('/api/messages/:targetId', (req, res) => {
    const me = req.session.userId; const target = req.params.targetId;
    db.all("SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY id ASC", [me, target, target, me], (err, rows) => res.json(rows || []));
});
app.post('/api/messages', (req, res) => {
    db.run("INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)", [req.session.userId, req.body.receiver_id, req.body.content], () => {
        db.run("INSERT INTO notifications (user_id, from_user, type) VALUES (?, ?, ?)", [req.body.receiver_id, req.session.username, 'sent you a message']);
        res.json({ message: "OK" });
    });
});
app.get('/api/notifications', (req, res) => {
    db.all("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 10", [req.session.userId], (err, rows) => res.json(rows || []));
});
app.post('/api/notifications/read', (req, res) => {
    db.run("UPDATE notifications SET is_read = 1 WHERE user_id = ?", [req.session.userId], () => res.json({message:"OK"}));
});
app.get('/api/admin/stats', (req, res) => {
    if (req.session.userId !== 1) return res.status(403).send();
    db.get("SELECT (SELECT COUNT(*) FROM users) as u_count, (SELECT COUNT(*) FROM posts) as p_count", [], (err, row) => res.json(row));
});
app.delete('/api/admin/user/:id', (req, res) => {
    if (req.session.userId !== 1) return res.status(403).send();
    db.run("DELETE FROM users WHERE id = ?", [req.params.id], () => res.json({message:"OK"}));
});
app.delete('/api/posts/:id', (req, res) => {
    db.get("SELECT username FROM posts WHERE id = ?", [req.params.id], (err, post) => {
        if (post && (req.session.userId === 1 || post.username === req.session.username)) {
            db.run("DELETE FROM posts WHERE id = ?", [req.params.id], () => res.json({ message: "Deleted" }));
        } else res.status(403).send();
    });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port ${PORT}`);
});
