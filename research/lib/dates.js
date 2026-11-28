'use strict';
// Explicit Africa/Kampala (UTC+03:00, no DST) natural-language date-range parser and validator.
// Never uses UTC midnight approximations or silently collapses multi-day ranges to a single day.

const KAMPALA_TZ = 'Africa/Kampala';
const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const SMALL_NUMS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  twenty: 20, thirty: 30,
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatYmd(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

// Convert any epoch ms into Africa/Kampala civil calendar parts (UTC+3).
function kampalaParts(ms = Date.now()) {
  const shifted = new Date(ms + KAMPALA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0=Sun..6=Sat
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function kampalaYmd(ms = Date.now()) {
  const p = kampalaParts(ms);
  return formatYmd(p.year, p.month, p.day);
}

// Strictly validate YYYY-MM-DD and return { year, month, day } or null.
function parseYmdParts(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

// Exact UTC epoch ms corresponding to 00:00:00.000 Africa/Kampala on YYYY-MM-DD.
function kampalaStartOfDayMs(ymdStr) {
  const p = parseYmdParts(ymdStr);
  if (!p) return NaN;
  return Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0) - KAMPALA_OFFSET_MS;
}

function addDaysYmd(ymdStr, deltaDays) {
  const p = parseYmdParts(ymdStr);
  if (!p) return null;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + deltaDays));
  return formatYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function datesBetween(startYmd, endYmd, maxDays = 75) {
  const s = parseYmdParts(startYmd);
  const e = parseYmdParts(endYmd);
  if (!s || !e) return [];
  const startMs = Date.UTC(s.year, s.month - 1, s.day);
  const endMs = Date.UTC(e.year, e.month - 1, e.day);
  if (endMs < startMs) return [];
  const count = Math.min(maxDays, Math.round((endMs - startMs) / DAY_MS) + 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(addDaysYmd(startYmd, i));
  }
  return out;
}

function parseSmallInt(tok) {
  if (tok == null) return null;
  const s = String(tok).trim().toLowerCase();
  if (/^\d{1,2}$/.test(s)) return Number(s);
  return SMALL_NUMS[s] != null ? SMALL_NUMS[s] : null;
}

function parseSingleCalendarDate(token, todayYmd) {
  const s = String(token || '').trim().toLowerCase();
  const iso = parseYmdParts(s);
  if (iso) return formatYmd(iso.year, iso.month, iso.day);

  const todayParts = parseYmdParts(todayYmd);
  if (!todayParts) return null;
  const todayUtc = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);

  const resolveMonthDay = (month, day, explicitYear) => {
    let year = explicitYear != null ? explicitYear : todayParts.year;
    let probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    if (explicitYear == null && probe.getTime() < todayUtc) {
      year += 1;
      probe = new Date(Date.UTC(year, month - 1, day));
      if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    }
    return formatYmd(year, month, day);
  };

  const dmy = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:,?\s+(\d{4}))?$/.exec(s);
  if (dmy && MONTHS[dmy[2]]) {
    return resolveMonthDay(MONTHS[dmy[2]], Number(dmy[1]), dmy[3] ? Number(dmy[3]) : null);
  }
  const mdy = /^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s);
  if (mdy && MONTHS[mdy[1]]) {
    return resolveMonthDay(MONTHS[mdy[1]], Number(mdy[2]), mdy[3] ? Number(mdy[3]) : null);
  }
  return null;
}

const DATE_TOK_RE =
  '(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:,?\\s+\\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)';
const NUM_WORD_RE = '(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty)';
const WD_TOK_RE = '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';

// Parse natural-language date phrasing in Africa/Kampala.
// Returns { matched, explicit, ambiguous, clarificationQuestion, scope, startDate, endDate, dates, timezone }.
function parseNaturalDateScope(rawText, nowMs = Date.now()) {
  const originalText = String(rawText || '').trim();
  const t = originalText.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
  const p = kampalaParts(nowMs);
  const today = formatYmd(p.year, p.month, p.day);
  const tomorrow = addDaysYmd(today, 1);

  const make = (scope, startDate, endDate, matched = true, extra = {}) => {
    const dates = startDate && endDate ? datesBetween(startDate, endDate) : [];
    return {
      originalText,
      matched,
      explicit: matched,
      ambiguous: false,
      clarificationQuestion: '',
      scope,
      startDate: startDate || '',
      endDate: endDate || '',
      dates,
      timezone: KAMPALA_TZ,
      ...extra,
    };
  };

  // 1) Explicit calendar date range: "from 2026-11-24 to 2026-11-27", "24 Nov through 27 Nov", etc.
  const rangeRe = new RegExp(
    `(?:from|between)\\s+(${DATE_TOK_RE})\\s+(?:to|and|until|through|-)\\s+(${DATE_TOK_RE})|(${DATE_TOK_RE})\\s+(?:to|until|through|-)\\s+(${DATE_TOK_RE})`,
    'i'
  );
  const rm = rangeRe.exec(t);
  if (rm) {
    const a = parseSingleCalendarDate(rm[1] || rm[3], today);
    const b = parseSingleCalendarDate(rm[2] || rm[4], today);
    if (a && b) {
      const start = a <= b ? a : b;
      const end = a <= b ? b : a;
      return make('range', start, end, true);
    }
  }

  // 2) "today and tomorrow" / "today & tomorrow" / "today to tomorrow" / "today through tomorrow"
  if (/\btoday\s*(?:and|&|to|through|until|\+|,|\/)\s*tomorrow\b/.test(t) || /\btomorrow\s*(?:and|&)\s*today\b/.test(t)) {
    return make('range', today, tomorrow, true);
  }

  // 3) "today and the next N days" / "today plus N days" (INCLUSIVE: today + N additional days = N+1 dates)
  const todayPlusRe = new RegExp(
    `\\btoday\\s*(?:and|&|plus|\\+)\\s*(?:the\\s+)?(?:next|following)\\s+(${NUM_WORD_RE})\\s+days?\\b`,
    'i'
  );
  const tpm = todayPlusRe.exec(t);
  if (tpm) {
    const n = parseSmallInt(tpm[1]);
    if (n >= 1 && n <= 30) {
      return make('range', today, addDaysYmd(today, n), true);
    }
  }

  // 4) "for N days from today" / "N days from today" / "for N days starting today" (INCLUSIVE: N total days including today)
  const forDaysRe = new RegExp(
    `\\b(?:for\\s+)?(?:the\\s+)?(${NUM_WORD_RE})\\s+days?\\s+(?:from|starting(?:\\s+from)?|beginning)\\s+today\\b|\\bstarting\\s+today\\s+for\\s+(${NUM_WORD_RE})\\s+days?\\b`,
    'i'
  );
  const fdm = forDaysRe.exec(t);
  if (fdm) {
    const n = parseSmallInt(fdm[1] || fdm[2]);
    if (n >= 1 && n <= 30) {
      const end = addDaysYmd(today, n - 1);
      return make(n === 1 ? 'today' : 'range', today, end, true);
    }
  }

  // 5) Short hour windows
  if (/\b(?:next|within(?:\s+the)?(?:\s+next)?)\s*(?:3|three)\s*hours?\b/.test(t)) {
    return make('next3hours', today, today, true);
  }
  if (/\b(?:next|within(?:\s+the)?(?:\s+next)?)\s*(?:6|six)\s*hours?\b/.test(t)) {
    return make('next6hours', today, today, true);
  }

  // 6) "next N days" (inclusive of today: N days total -> today .. today + N - 1)
  const nextDaysRe = new RegExp(`\\b(?:the\\s+)?next\\s+(${NUM_WORD_RE})\\s+days?\\b`, 'i');
  const ndm = nextDaysRe.exec(t);
  if (ndm) {
    const n = parseSmallInt(ndm[1]);
    if (n >= 1 && n <= 30) {
      const end = addDaysYmd(today, n - 1);
      const sc = n === 1 ? 'today' : (n === 3 ? 'next3days' : (n === 7 ? 'next7days' : 'range'));
      return make(sc, today, end, true);
    }
  }

  // 7) Weekday range: "from Friday through Sunday", "Friday to Sunday", "between Sat and Mon"
  const wdRangeRe = new RegExp(
    `\\b(?:from|between)\\s+(${WD_TOK_RE})\\s+(?:to|through|thru|until|and|-)\\s+(${WD_TOK_RE})\\b|\\b(${WD_TOK_RE})\\s+(?:to|through|thru|until|-)\\s+(${WD_TOK_RE})\\b`,
    'i'
  );
  const wrm = wdRangeRe.exec(t);
  if (wrm) {
    const wA = WEEKDAYS[(wrm[1] || wrm[3]).toLowerCase()];
    const wB = WEEKDAYS[(wrm[2] || wrm[4]).toLowerCase()];
    if (wA != null && wB != null) {
      const toStart = (wA - p.weekday + 7) % 7;
      const span = (wB - wA + 7) % 7;
      const start = addDaysYmd(today, toStart);
      const end = addDaysYmd(start, span);
      return make('range', start, end, true);
    }
  }

  // 8) Explicit single calendar date
  const singleDateRe = new RegExp(`\\b(${DATE_TOK_RE})\\b`, 'i');
  const sdm = singleDateRe.exec(t);
  if (sdm) {
    const d = parseSingleCalendarDate(sdm[1], today);
    if (d) return make('date', d, d, true);
  }

  // 9) Weekend ("this weekend" / "weekend")
  if (/\b(?:this\s+)?weekend\b/.test(t)) {
    if (p.weekday === 0) {
      return make('weekend', today, today, true);
    }
    const toSat = (6 - p.weekday + 7) % 7;
    const sat = addDaysYmd(today, toSat);
    const sun = addDaysYmd(sat, 1);
    return make('weekend', sat, sun, true);
  }

  // 9.5) Genuinely ambiguous date phrases (must be checked BEFORE "this week" so "later this week" asks for clarification!)
  if (/\b(a\s+few\s+days?|some\s+days?|couple\s+of\s+days?|later\s+this\s+week|sometime\s+this\s+week|upcoming\s+days?|soon)\b/.test(t)) {
    return {
      originalText,
      matched: false,
      explicit: false,
      ambiguous: true,
      clarificationQuestion: 'Which exact dates should I search (for example: today, today and tomorrow, next 3 days, or this weekend)?',
      scope: '',
      startDate: '',
      endDate: '',
      dates: [],
      timezone: KAMPALA_TZ,
    };
  }

  // 10) "this week" / "next week"
  if (/\b(?:next\s+week|this\s+week)\b/.test(t)) {
    return make('next7days', today, addDaysYmd(today, 6), true);
  }

  // 11) Single-day keywords
  if (/\btomorrow\b/.test(t)) {
    return make('tomorrow', tomorrow, tomorrow, true);
  }
  if (/\btoday\b/.test(t)) {
    return make('today', today, today, true);
  }
  if (/\b(?:all\s*dates?|any\s*time)\b/.test(t)) {
    return make('all', today, addDaysYmd(today, 29), true);
  }

  return make('today', today, today, false);
}

// Decide which BangBet Time menu tabs must be queried so every requested calendar date is genuinely covered.
function planBangbetTabs(startDate, endDate, scope, todayYmd) {
  if (scope === 'next3hours') return ['next3hours'];
  if (scope === 'next6hours') return ['next6hours'];
  if (scope === 'today') return ['today'];
  if (scope === 'tomorrow') return ['tomorrow'];
  if (scope === 'weekend') return ['weekend'];
  if (scope === 'all') return ['all'];

  const sMs = kampalaStartOfDayMs(startDate);
  const eMs = kampalaStartOfDayMs(endDate || startDate);
  const tMs = kampalaStartOfDayMs(todayYmd);
  if (!Number.isFinite(sMs) || !Number.isFinite(eMs) || !Number.isFinite(tMs)) {
    return [scope || 'today'];
  }
  const diffStart = Math.round((sMs - tMs) / DAY_MS);
  const diffEnd = Math.round((eMs - tMs) / DAY_MS);

  if (diffStart === 0 && diffEnd === 0) return ['today'];
  if (diffStart === 1 && diffEnd === 1) return ['tomorrow'];
  // For "today and tomorrow", querying BOTH BangBet's Today and Tomorrow tabs guarantees
  // neither day is truncated by BangBet's listing pagination or tab boundaries.
  if (diffStart === 0 && diffEnd === 1) return ['today', 'tomorrow'];
  if (diffStart === 0 && diffEnd <= 2) return ['today', 'tomorrow', 'next3days'];
  if (diffStart >= 0 && diffEnd <= 2) return ['next3days'];
  if (diffStart === 0 && diffEnd <= 6) return ['today', 'tomorrow', 'next7days'];
  if (diffStart >= 0 && diffEnd <= 6) return ['next7days'];
  return ['all'];
}

// Resolve a structured job request + optional natural-language text into a complete, authoritative
// Africa/Kampala dateScope with exact [fromMs, toMs) boundaries and BangBet tab plan.
function resolveDateScope(req = {}, nowMs = Date.now()) {
  const p = kampalaParts(nowMs);
  const today = formatYmd(p.year, p.month, p.day);
  const tomorrow = addDaysYmd(today, 1);

  const rawText = String(req.text || '').trim();
  const parsedFromText = rawText ? parseNaturalDateScope(rawText, nowMs) : null;

  let scope = String(req.scope || '').trim() || 'today';
  let startDate = '';
  let endDate = '';

  // Protect against upstream clients accidentally collapsing a multi-day natural request
  // ("today and tomorrow") into a single-day scope or passing scope="range" without dateFrom/dateTo.
  const hasExplicitDates = !!(req.dateFrom || req.dateTo || req.date || (Array.isArray(req.dates) && req.dates.length));
  if (
    !hasExplicitDates &&
    parsedFromText &&
    parsedFromText.matched &&
    ((scope === 'range' || scope === 'date') ||
      (parsedFromText.dates.length > 1 && (scope === 'today' || scope === 'tomorrow')))
  ) {
    scope = parsedFromText.scope;
    startDate = parsedFromText.startDate;
    endDate = parsedFromText.endDate;
  } else if (Array.isArray(req.dates) && req.dates.length) {
    const valid = req.dates.filter((d) => parseYmdParts(d)).sort();
    if (valid.length) {
      startDate = valid[0];
      endDate = valid[valid.length - 1];
      scope = valid.length === 1 ? 'date' : 'range';
    }
  } else if (scope === 'range' && req.dateFrom) {
    startDate = String(req.dateFrom).trim();
    endDate = String(req.dateTo || req.dateFrom).trim();
  } else if (scope === 'date' && req.date) {
    startDate = String(req.date).trim();
    endDate = startDate;
  } else {
    switch (scope) {
      case 'next3hours':
      case 'next6hours':
      case 'today':
        startDate = today;
        endDate = today;
        break;
      case 'tomorrow':
        startDate = tomorrow;
        endDate = tomorrow;
        break;
      case 'next3days':
        startDate = today;
        endDate = addDaysYmd(today, 2);
        break;
      case 'next7days':
      case 'week':
        startDate = today;
        endDate = addDaysYmd(today, 6);
        break;
      case 'weekend': {
        if (p.weekday === 0) {
          startDate = today;
          endDate = today;
        } else {
          const toSat = (6 - p.weekday + 7) % 7;
          startDate = addDaysYmd(today, toSat);
          endDate = addDaysYmd(startDate, 1);
        }
        break;
      }
      case 'all':
        startDate = today;
        endDate = addDaysYmd(today, 29);
        break;
      default:
        startDate = today;
        endDate = today;
        break;
    }
  }

  const dates = datesBetween(startDate, endDate);
  let fromMs;
  let toMs;
  if (scope === 'next3hours') {
    fromMs = nowMs;
    toMs = nowMs + 3 * 60 * 60 * 1000;
  } else if (scope === 'next6hours') {
    fromMs = nowMs;
    toMs = nowMs + 6 * 60 * 60 * 1000;
  } else {
    const startMidnight = kampalaStartOfDayMs(startDate);
    const endExclusive = kampalaStartOfDayMs(addDaysYmd(endDate, 1));
    // Explicit calendar dates and date ranges ALWAYS preserve complete Africa/Kampala midnight boundaries.
    // Relative live scopes starting today allow matches starting up to 5 min ago (kickoff grace).
    const isExplicitCalendar = scope === 'date' || scope === 'range';
    fromMs = (!isExplicitCalendar && startDate === today)
      ? Math.max(startMidnight, nowMs - 5 * 60 * 1000)
      : startMidnight;
    toMs = endExclusive;
  }

  const expandedResearchPool = isExpandedDateRange({ scope, dates });

  return {
    originalText: rawText,
    scope,
    startDate,
    endDate,
    dates,
    timezone: KAMPALA_TZ,
    fromMs,
    toMs,
    expandedResearchPool,
    bangbetTabs: planBangbetTabs(startDate, endDate, scope, today),
    ambiguous: !!(parsedFromText && parsedFromText.ambiguous && !hasExplicitDates),
    clarificationQuestion: (parsedFromText && parsedFromText.clarificationQuestion) || '',
  };
}

// Part 5: Determine whether a resolved dateScope activates the expanded 200/100 research pool.
// Activates for Weekend, custom date ranges spanning > 2 calendar days, or longer multi-day scopes
// (next3days, next7days, week, all). Does NOT activate for today, tomorrow, single dates, or 2-day ranges.
function isExpandedDateRange(dateScope) {
  if (!dateScope || typeof dateScope !== 'object') return false;
  const sc = String(dateScope.scope || '').toLowerCase();
  if (sc === 'weekend' || sc === 'next3days' || sc === 'next7days' || sc === 'week' || sc === 'all') {
    return true;
  }
  const dates = Array.isArray(dateScope.dates) ? dateScope.dates : [];
  if (dates.length > 2) return true;
  return false;
}

module.exports = {
  KAMPALA_TZ,
  KAMPALA_OFFSET_MS,
  kampalaParts,
  kampalaYmd,
  parseYmdParts,
  kampalaStartOfDayMs,
  addDaysYmd,
  datesBetween,
  parseNaturalDateScope,
  resolveDateScope,
  planBangbetTabs,
  isExpandedDateRange,
};
