# Fix Event Deduplication - Title + CourseID Composite Key

## Problem
Current logic on `scrap.js:253-255`:
- Filters out `close` events: `ev.evType !== 'close'`
- Deduplicates by `evID` only: `existingIDs.has(ev.evID)`

Since open/close/due events have different `evID` values for the same course content, the system ignores close events entirely and misses new ones with different IDs.

## Current problematic code

```js
const existingIDs = new Set(normalizedExisting.map(e => e.evID));
// ...
const openAndNew = allEventsMeta.filter(ev =>
    ev.evType !== 'close' && !existingIDs.has(ev.evID)
);
```

## Changes needed in scrap.js

### Step 1: Replace the existingIDs dedup approach

Replace `scrap.js:145` with composite key dedup using **Title + CourseID**:

**Before:**
```js
const existingIDs = new Set(normalizedExisting.map(e => e.evID));
let allEvents = [...normalizedExisting];
```

**After:**
```js
const existingKeys = new Set(normalizedExisting.map(e => `${e.evTitle}||${e.cID}`));
let allEvents = [...normalizedExisting];

// Deduplicate CSV (remove duplicate Title+CourseID entries)
const seen = new Set();
const dedupedAllEvents = [];
for (const e of allEvents) {
    const key = `${e.evTitle}||${e.cID}`;
    if (!seen.has(key)) {
        seen.add(key);
        dedupedAllEvents.push(e);
    }
}
allEvents = dedupedAllEvents;
```

### Step 2: Remove the close filter

Replace `scrap.js:253-255`:

**Before:**
```js
const openAndNew = allEventsMeta.filter(ev =>
    ev.evType !== 'close' && !existingIDs.has(ev.evID)
);
```

**After:**
```js
const newEvents = allEventsMeta.filter(ev => {
    const key = `${ev.evTitle}||${ev.cID}`;
    return !existingKeys.has(key);
});
```

### Step 3: Update the tracking in the insert loop

Replace `scrap.js:316` (which does `existingIDs.add(ev.evID)`) with:

**Before:**
```js
existingIDs.add(ev.evID);
```

**After:**
```js
existingKeys.add(`${ev.evTitle}||${ev.cID}`);
```

## Summary
- **All event types** (open, close, due) now get processed
- Deduplication uses **composite key** `Title||CourseID` instead of `evID`
- No more close events being ignored
- No duplicates of same content with different event IDs