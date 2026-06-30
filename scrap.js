// scraper.js
const { chromium } = require('playwright-core');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const csv = require('csv-parser');
const { insertEvent } = require('./calendar');
require('dotenv').config();
const path = require('path');

const folder = path.join(__dirname, 'db');

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

    // FIX: CSV is written with title 'EventID', so re-read rows have key 'EventID'.
    // Normalize them back to evID so allEvents always uses one consistent shape.
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
            console.error('❌ Invalid CSV writer provided');
            return;
        }
        try {
            await writer.writeRecords(data);
            console.log(`📁 CSV updated: ${checkFilePath}`);
        } catch (error) {
            console.error('❌ Error writing CSV:', error);
        }
    }

    // ── Phase 0: Launch main browser, login, goto calendar ──
    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH,
        headless: false,
        args: ['--no-sandbox', '--disable-gpu']
    });
    const page = await browser.newPage();

    await page.goto("https://lms.psu.ac.th/login/index.php?loginredirect=1");
    await page.type("input[name=username]", username, { delay: 10 });
    await page.type("input[name=password]", password, { delay: 10 });
    page.click("button[id=close-popup-btn]");
    await page.click("button[id=loginbtn]");
    await page.waitForLoadState();

    await page.goto("https://lms.psu.ac.th/calendar/view.php");
    await page.waitForLoadState();

    // ── Phase 1: Extract ALL event metadata in ONE evaluate() call ──
    const allEventsMeta = await page.evaluate(() => {
        const events = [];
        document.querySelectorAll('div.event').forEach((evt, index) => {
            const evID       = evt.getAttribute('data-event-id');
            const cID        = evt.getAttribute('data-course-id');
            const evTitle    = evt.getAttribute('data-event-title');
            const evType     = evt.getAttribute('data-event-eventtype');

            // Course extraction logic - same as original single-page code
            const selA = `div.event:nth-child(${index + 1}) > div:nth-child(1) > div:nth-child(2) > div:nth-child(3) > div:nth-child(2)`;
            const selB = `div.event:nth-child(${index + 1}) > div:nth-child(1) > div:nth-child(2) > div:nth-child(4) > div:nth-child(2)`;

            const elA = document.querySelector(selA);
            const elB = document.querySelector(selB);

            let course = 'Unknown Course';
            if (elA && elB) {
                const classAttr = elA.getAttribute('class') || '';
                course = classAttr.trim() === 'description-content col-11'
                    ? (elB?.textContent?.trim() || 'Unknown Course')
                    : (elA?.textContent?.trim() || 'Unknown Course');
            } else if (elA) {
                course = elA.textContent?.trim() || 'Unknown Course';
            } else if (elB) {
                course = elB.textContent?.trim() || 'Unknown Course';
            }

            // Link extraction - the anchor inside the event
            const linkSel = `div.event:nth-child(${index + 1}) > div:nth-child(1) > div:nth-child(3) > a:nth-child(1)`;
            const linkEl = document.querySelector(linkSel);
            const link = linkEl?.getAttribute('href') || '';

            events.push({ evID, cID, evTitle, evType, course, link });
        });
        return events;
    });

    console.log(`📌 Found ${allEventsMeta.length} total events`);

    // ── Phase 2: Filter to open + new events ──
    const openAndNew = allEventsMeta.filter(ev =>
        ev.evType !== 'close' && !existingIDs.has(ev.evID)
    );

    console.log(`Fetching dates for ${openAndNew.length} new events sequentially...`);

    // ── Phase 3: Single browser sequential: goto each event link, grab date data ──
    const results = [];

    for (const ev of openAndNew) {
        await page.goto(ev.link);
        await page.waitForLoadState("networkidle");

        const dates = await page.evaluate(() => {
            const openEl = document.querySelector('.activity-dates > div:nth-child(1)');
            const closeEl = document.querySelector('.activity-dates > div:nth-child(2)');
            if (!openEl) return null;

            let opened = openEl.textContent?.trim() || '';
            let closes = closeEl?.textContent?.trim() || '';

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
    }

    // ── Phase 4: Sequential calendar insertion ──
    for (const ev of results) {
        const glendar = {
            summary: ev.evTitle,
            description: ev.course,
            location: ev.link,
            start: { dateTime: ev.opened, timeZone: 'Asia/Bangkok' },
            end:   { dateTime: ev.closes, timeZone: 'Asia/Bangkok' },
            colorId: "6"
        };

        console.log("📅 Inserting event:", glendar.summary);
        await insertEvent(glendar, username);

        allEvents.push(ev);
        existingIDs.add(ev.evID);
    }

    // ── Phase 5: Write CSV and cleanup ──
    await write(check, allEvents);
    await browser.close();
    console.log("✅ Scraping finished for", username);
}

module.exports = { run };
