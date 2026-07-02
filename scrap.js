// scraper.js
const { chromium } = require('playwright-core');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const csv = require('csv-parser');
const http = require('http');
const { spawn } = require('child_process');
const { insertEvent } = require('./calendar');
require('dotenv').config();
const path = require('path');

const folder = path.join(__dirname, 'db');

let lightpandaProcess = null;
let cdpBrowser = null;
let lightpandaInitialized = false;

function waitForCDPReady(port) {
    return new Promise((resolve, reject) => {
        const check = () => {
            http.get(`http://127.0.0.1:${port}/json/version`, res => {
                if (res.statusCode === 200) {
                    resolve();
                } else {
                    setTimeout(check, 500);
                }
            }).on('error', () => {
                setTimeout(check, 500);
            });
        };
        setTimeout(check, 1000);
    });
}

async function ensureLightpanda() {
    if (lightpandaInitialized) return;

    const PORT = process.env.LIGHTPANDA_PORT || 9222;
    const CACHE_DIR = process.env.LIGHTPANDA_CACHE_DIR || path.join(__dirname, '.lightpanda-cache');

    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    console.log(`Starting Lightpanda on 127.0.0.1:${PORT}...`);
    lightpandaProcess = spawn('lightpanda', [
        'serve',
        '--host', '127.0.0.1',
        '--port', PORT.toString(),
        '--log-level', 'warn',
        '--http-cache-dir', CACHE_DIR,
        '--storage-engine', 'sqlite',
        '--storage-sqlite-path', path.join(CACHE_DIR, 'lightpanda.db')
    ], { stdio: 'pipe', detached: false });

    lightpandaProcess.on('error', (err) => {
        console.error('Failed to start lightpanda:', err.message);
        process.exit(1);
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            lightpandaProcess.kill();
            reject(new Error('Timed out waiting for Lightpanda to start'));
        }, 30000);

        lightpandaProcess.stderr.on('data', (data) => {
            const lines = data.toString().trim();
            if (lines) console.warn(`[lightpanda] ${lines}`);
        });

        lightpandaProcess.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                clearTimeout(timeout);
                reject(new Error(`Lightpanda exited with code ${code}`));
            }
        });

        waitForCDPReady(PORT).then(() => {
            clearTimeout(timeout);
            console.log(`Lightpanda ready on port ${PORT}`);
            resolve();
        }).catch(reject);
    });

    const cdpUrl = `http://127.0.0.1:${PORT}`;
    console.log(`Connecting to CDP server at ${cdpUrl}...`);
    cdpBrowser = await chromium.connectOverCDP(cdpUrl);
    lightpandaInitialized = true;
}

function waitForSelector(page, selector, timeout = 10000) {
    return new Promise((resolve) => {
        const start = Date.now();
        function check() {
            page.evaluate(sel => {
                return document.querySelector(sel) !== null;
            }, selector).then(found => {
                if (found) { resolve(true); return; }
                if (Date.now() - start > timeout) { resolve(false); return; }
                setTimeout(check, 200);
            }).catch(() => {
                if (Date.now() - start > timeout) { resolve(false); return; }
                setTimeout(check, 200);
            });
        }
        check();
    });
}

async function clickIfExists(page, selector) {
    return page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (el) { try { el.click(); } catch(e) {} return true; }
        return false;
    }, selector).catch(() => false);
}

async function readCSV(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => rows.push(row))
            .on('end', () => resolve(rows))
            .on('error', reject);
    });
}

async function run(username, password) {
    const checkFilePath = path.join(folder, `check${username}.csv`);

    const existingEvents = await readCSV(checkFilePath);

    const normalizedExisting = existingEvents.map(e => ({
        evID:    e.evID    ?? e.EventID,
        cID:     e.cID     ?? e.CourseID,
        evTitle: e.evTitle ?? e.Title,
        evType:  e.evType  ?? e.EventType,
        opened:  e.opened  ?? e.EventOpen,
        closes:  e.closes  ?? e.EventClose,
    }));

    const existingIDs = new Set(normalizedExisting.map(e => e.evID));
    let allEvents = [...normalizedExisting];

    const check = createCsvWriter({
        path: checkFilePath,
        header: [
            { id: 'evID',    title: 'EventID' },
            { id: 'cID',     title: 'CourseID' },
            { id: 'evTitle', title: 'Title' },
            { id: 'evType',  title: 'EventType' },
            { id: 'opened',  title: 'EventOpen' },
            { id: 'closes',  title: 'EventClose' },
        ]
    });

    async function write(writer, data) {
        if (!writer || typeof writer.writeRecords !== 'function') {
            console.error('Invalid CSV writer provided');
            return;
        }
        try {
            await writer.writeRecords(data);
            console.log(`CSV updated: ${checkFilePath}`);
        } catch (error) {
            console.error('Error writing CSV:', error);
        }
    }

    await ensureLightpanda();

    const page = await cdpBrowser.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Critical: inject JS patches BEFORE page loads to prevent Lightpanda sandbox issues
    // 1. Remove cross-origin jQuery that blocks access
    // 2. Remove event listeners that trigger cross-frame access
    await page.addInitScript(() => {
        // Patch EventTarget.addEventListener to ignore errors from cross-frame handlers
        const origAdd = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
            try {
                origAdd.call(this, type, listener, options);
            } catch(e) {}
        };

        // Remove all jQuery event handlers from document.body that might cause cross-frame issues
        try {
            if (window.jQuery) {
                // Clear jQuery data storage to prevent cross-frame access
                window.jQuery._data = function() { return {}; };
            }
        } catch(e) {}
    });

    try {
        await page.goto("https://lms.psu.ac.th/login/index.php?loginredirect=1", {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });

        // Wait for login form
        await page.waitForSelector("input[name=username]", { timeout: 15000 });
        await page.fill("input[name=username]", username);
        await page.fill("input[name=password]", password);

        // Close popup if present
        const popupExists = await clickIfExists(page, "button[id=close-popup-btn]");
        if (popupExists) {
            await page.waitForTimeout(500);
        }

        await page.click("button[id=loginbtn]");
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 });

        await page.goto("https://lms.psu.ac.th/calendar/view.php", {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });

        // Wait for calendar to render
        await page.waitForTimeout(5000);

        // ── Extract ALL event metadata ──
        const allEventsMeta = await page.evaluate(() => {
            const events = [];
            document.querySelectorAll('div.event').forEach((evt, index) => {
                const evID = evt.getAttribute('data-event-id');
                const cID = evt.getAttribute('data-course-id');
                const evTitle = evt.getAttribute('data-event-title');
                const evType = evt.getAttribute('data-event-eventtype');

                let course = 'Unknown Course';
                const linkSel = `div.event:nth-child(${index + 1}) > div:nth-child(1) > div:nth-child(3) > a:nth-child(1)`;
                const linkEl = document.querySelector(linkSel);
                const link = linkEl ? (linkEl.getAttribute('href') || '') : '';

                events.push({ evID, cID, evTitle, evType, course, link });
            });
            return events;
        });

        console.log(`Found ${allEventsMeta ? allEventsMeta.length : 0} total events`);

        if (!allEventsMeta) {
            await write(check, allEvents);
            return;
        }

        const openAndNew = allEventsMeta.filter(ev =>
            ev.evType !== 'close' && !existingIDs.has(ev.evID)
        );

        console.log(`Fetching dates for ${openAndNew.length} new events sequentially...`);

        const results = [];

        for (const ev of openAndNew) {
            try {
                await page.goto(ev.link, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                await page.waitForTimeout(3000);

                const dates = await page.evaluate(() => {
                    const openEl = document.querySelector('.activity-dates > div:nth-child(1)');
                    const closeEl = document.querySelector('.activity-dates > div:nth-child(2)');
                    if (!openEl) return null;

                    let opened = openEl.textContent ? openEl.textContent.trim() : '';
                    let closes = closeEl && closeEl.textContent ? closeEl.textContent.trim() : '';

                    if (opened.startsWith("Opens:") || opened.startsWith("Opened:"))
                        opened = opened.split(" ").slice(1).join(" ");
                    if (closes.startsWith("Closes:") || closes.startsWith("Due:"))
                        closes = closes.split(" ").slice(1).join(" ");

                    return { opened, closes };
                });

                if (!dates || !dates.opened) continue;

                results.push({
                    evID:     ev.evID,
                    cID:      ev.cID,
                    evTitle:  ev.evTitle,
                    evType:   ev.evType,
                    course:   ev.course,
                    link:     ev.link,
                    opened:   new Date(dates.opened).toISOString(),
                    closes:   new Date(dates.closes).toISOString(),
                });
            } catch (e) {
                console.warn(`Failed to fetch dates for ${ev.evTitle}:`, e.message);
            }
        }

        for (const ev of results) {
            const glendar = {
                summary: ev.evTitle,
                description: ev.course,
                location: ev.link,
                start: { dateTime: ev.opened, timeZone: 'Asia/Bangkok' },
                end:   { dateTime: ev.closes, timeZone: 'Asia/Bangkok' },
                colorId: "6"
            };

            console.log("Inserting event:", glendar.summary);
            await insertEvent(glendar, username);

            allEvents.push(ev);
            existingIDs.add(ev.evID);
        }

        await write(check, allEvents);
    } finally {
        await page.close().catch(() => {});
    }

    console.log("Scraping finished for", username);
}

process.on('SIGINT', () => {
    console.log('Shutting down lightpanda...');
    if (cdpBrowser) cdpBrowser.close().catch(() => {});
    if (lightpandaProcess) lightpandaProcess.kill();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Shutting down lightpanda...');
    if (cdpBrowser) cdpBrowser.close().catch(() => {});
    if (lightpandaProcess) lightpandaProcess.kill();
    process.exit(0);
});

module.exports = { run };
