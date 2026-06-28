// scraper.js
const { chromium } = require('playwright-core');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const csv = require('csv-parser');
const { insertEvent } = require('./calendar');
require('dotenv').config();
const path = require('path');

const folder = path.join(__dirname, 'db');

async function run(username, password) {
    const checkFilePath = path.join(folder, `check${username}.csv`);

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

    const existingEvents = await readCSV(checkFilePath);

    // ✅ FIX: CSV is written with title 'EventID', so re-read rows have key 'EventID'.
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

    const browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH,
        headless: false,
        args: ['--no-sandbox', '--disable-gpu']
    });
    const page = await browser.newPage();

    await page.goto("https://lms.psu.ac.th/login/index.php?loginredirect=1");
    await page.type("input[name=username]", username, { delay: 10 });
    await page.type("input[name=password]", password, { delay: 10 });
    await page.click("button[id=loginbtn]");
    await page.waitForLoadState();

    await page.goto("https://lms.psu.ac.th/calendar/view.php");
    await page.waitForLoadState();

    const eventCount = await page.$$eval("div.event", (nodes) => nodes.length);
    console.log(`📌 Found ${eventCount} events`);

    let Course = "Unknown Course";

    for (let i = 1; i <= eventCount; i++) {
        const selector = `div.event:nth-child(${i})`;
        const parent = await page.$(selector);

        if (!parent) {
            console.log(`⚠️ No event at index ${i}, skipping`);
            continue;
        }

        const evID    = await parent.getAttribute("data-event-id");
        const cID     = await parent.getAttribute("data-course-id");
        const evTitle = await parent.getAttribute("data-event-title");
        const evType  = await parent.getAttribute("data-event-eventtype");

        if (existingIDs.has(evID)) {
            console.log(`⏩ EventID ${evID} already exists, skipping`);
            continue;
        }
        if (evType === "close") {
            console.log(`⏩ EventID ${evID} is closed, skipping`);
            continue;
        }

        const selA = `${selector} > div:nth-child(1) > div:nth-child(2) > div:nth-child(3) > div:nth-child(2)`;
        const selB = `${selector} > div:nth-child(1) > div:nth-child(2) > div:nth-child(4) > div:nth-child(2)`;
        const locA = page.locator(selA);
        const locB = page.locator(selB);

        let courseDiv;
        if (await locA.count() > 0) {
            const classAttr = (await locA.first().getAttribute('class')) || '';
            courseDiv = classAttr.trim() === 'description-content col-11' ? selB : selA;
        } else {
            courseDiv = (await locB.count() > 0) ? selB : selA;
        }

        const rawCourse = await page.locator(courseDiv).textContent();
        Course = rawCourse ? rawCourse.trim() : 'Unknown Course';
        console.log(`Course is ${Course}`);

        const evLink = await page.$eval(
            `${selector} > div:nth-child(1) > div:nth-child(3) > a:nth-child(1)`,
            el => el.getAttribute("href")
        );

        await page.click(`${selector} > div:nth-child(1) > div:nth-child(3) > a:nth-child(1)`);
        await page.waitForLoadState("networkidle");

        const hasDates = await page.$('.activity-dates');
        if (!hasDates) {
            await page.goBack();
            continue;
        }

        let opened = (await page.textContent(".activity-dates > div:nth-child(1)")).trim();
        let closes = (await page.textContent(".activity-dates > div:nth-child(2)")).trim();

        if (opened.startsWith("Opens:") || opened.startsWith("Opened:"))
            opened = opened.split(" ").slice(1).join(" ");
        if (closes.startsWith("Closes:") || closes.startsWith("Due:"))
            closes = closes.split(" ").slice(1).join(" ");

        await page.goBack();

        // ✅ evData uses evID (consistent with normalized shape)
        const evData = { evID, cID, evTitle, evType, opened, closes };
        allEvents.push(evData);
        existingIDs.add(evID); // ✅ Guard against duplicates within same run

        const glendar = {
            summary: evTitle,
            description: `${Course}`,
            location: evLink,
            start: { dateTime: new Date(opened).toISOString(), timeZone: 'Asia/Bangkok' },
            end:   { dateTime: new Date(closes).toISOString(), timeZone: 'Asia/Bangkok' },
            colorId: "6"
        };

        console.log("📅 Inserting event:", glendar.summary);
        await insertEvent(glendar, username);
        await page.waitForLoadState("networkidle");
    }

    await write(check, allEvents);
    await browser.close();
    console.log("✅ Scraping finished for", username);
}

module.exports = { run };