const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const { oauth2Client, getTokens, saveToken } = require('./auth');
const { run } = require('./scrap');
const fs = require('fs');
require('dotenv').config();
let scrapperRunning = false;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: 'multi-user-secret', resave: false, saveUninitialized: true }));
app.set('view engine', 'ejs');

// Show login form
app.get('/', (req, res) => {
    res.render('form');
});

// Handle form submit
app.post('/submit', (req, res) => {
    const { username, password } = req.body;
    req.session.username = username;
    req.session.password = password;

    res.redirect('/auth');
});

// Google OAuth login
app.get('/auth', (req, res) => {
    const { getAuthUrl } = require('./auth');
    res.redirect(getAuthUrl());
});

// OAuth callback
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    const username = req.session.username;
    const password = req.session.password;

    try {
        const tokens = await getTokens(code);

        // Save tokens + password for this user
        saveToken(username, { ...tokens, password });

        res.send(`Credentials saved and ready for scheduled scraping.`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error during OAuth or scraper setup");
    }
});

const tokensFile = 'tokens.json';

async function runScrape() {
    console.log("🚀 Running scraper for all users...");
    const tokensFile = 'tokens.json';
    let allUsers = {};
    try {
        const raw = fs.readFileSync(tokensFile, 'utf8').trim();
        allUsers = raw ? JSON.parse(raw) : {};
    } catch (err) {
        console.error(`Failed to parse ${tokensFile}:`, err.message);
        return;
    }
    for (const username in allUsers) {
        const user = allUsers[username];
        console.log(`🔄 Processing user: ${username}`);
        try {
            // Refresh token if needed
            oauth2Client.setCredentials(user);
            if (user.refresh_token) {
                const { credentials } = await oauth2Client.refreshAccessToken();
                user.access_token = credentials.access_token;
                user.expiry_date = credentials.expiry_date;
                saveToken(username, user);
            }
            const password = user.password;
            if (!password) {
                console.log(`❌ No password found for ${username}`);
                continue;
            }

            console.log(`🔑 password ${password}`);
            // Run scraper
            await run(username, password);
            console.log(`✅ Scraper completed for ${username}`);
        } catch (err) {
            console.error(`❌ Failed for ${username}:`, err.message);
        }
    }
};

if (!fs.existsSync(tokensFile)) return console.log("No users found");
else {
    // Initial run
    runScrape();
    // Schedule every 10 minutes
}
cron.schedule('*/30 * * * *', runScrape);

app.listen(3000, () => {
    console.log("Server running at http://localhost:3000");
    console.log("Scraper will run automatically every 10 minutes for all users.");
});
